/** Shared provider-call gate and accounting for generation and Q&A. */
import { LearningError } from "../contracts/index.js";
import type {
  ChatModelLike,
  ConversationId,
  Database,
  JobId,
  ModelHandle,
  ModelRole,
  UsageKind,
  UsageMeter,
} from "../contracts/index.js";
import { MODEL_CONCURRENCY } from "./defaults.js";
// ── model concurrency gate (§20) ────────────────────────────────────────────

/** Per-role permits: one repo job, one page worker and one QA slot (§20). */
const ROLE_PERMITS: Readonly<Record<ModelRole, number>> = Object.freeze({
  repo_job: 1,
  page_worker: 1,
  lesson: 1,
  qa: 1,
  change: 1,
});

export interface ModelGate {
  run<T>(role: ModelRole, task: () => Promise<T>): Promise<T>;
  active(): number;
  maxActive(): number;
  activeFor(role: ModelRole): number;
  maxActiveFor(role: ModelRole): number;
}

/**
 * Global concurrency is `MODEL_CONCURRENCY` (2) with at most one permit per
 * role. A permit is released in `finally`, including on abort.
 */
export function createModelGate(): ModelGate {
  let active = 0;
  let maxActive = 0;
  const activeByRole: Partial<Record<ModelRole, number>> = {};
  const maxByRole: Partial<Record<ModelRole, number>> = {};
  const waiters: (() => void)[] = [];

  const canAcquire = (role: ModelRole): boolean =>
    active < MODEL_CONCURRENCY &&
    (activeByRole[role] ?? 0) < (ROLE_PERMITS[role] ?? 1);

  const wake = (): void => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  const acquire = async (role: ModelRole): Promise<void> => {
    while (!canAcquire(role)) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    activeByRole[role] = (activeByRole[role] ?? 0) + 1;
    maxActive = Math.max(maxActive, active);
    maxByRole[role] = Math.max(maxByRole[role] ?? 0, activeByRole[role] ?? 0);
  };

  const release = (role: ModelRole): void => {
    active -= 1;
    activeByRole[role] = Math.max(0, (activeByRole[role] ?? 0) - 1);
    wake();
  };

  return {
    async run<T>(role: ModelRole, task: () => Promise<T>): Promise<T> {
      await acquire(role);
      try {
        return await task();
      } finally {
        release(role);
      }
    },
    active: () => active,
    maxActive: () => maxActive,
    activeFor: (role) => activeByRole[role] ?? 0,
    maxActiveFor: (role) => maxByRole[role] ?? 0,
  };
}

// ── usage / quota instrumentation ───────────────────────────────────────────

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(0, Math.ceil(text.length / 4));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (
        block !== null &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function tokensOf(
  result: unknown,
  args: unknown[],
): {
  input: number;
  output: number;
} {
  if (result !== null && typeof result === "object") {
    const usage = (result as { usage_metadata?: Record<string, unknown> })
      .usage_metadata;
    if (usage !== undefined) {
      const input = Number(usage.input_tokens ?? 0);
      const output = Number(usage.output_tokens ?? 0);
      if (input > 0 || output > 0) return { input, output };
    }
    const metadata = (result as { response_metadata?: Record<string, unknown> })
      .response_metadata;
    const tokenUsage = metadata?.tokenUsage as
      Record<string, unknown> | undefined;
    if (tokenUsage !== undefined) {
      const input = Number(
        tokenUsage.promptTokens ?? tokenUsage.inputTokens ?? 0,
      );
      const output = Number(
        tokenUsage.completionTokens ?? tokenUsage.outputTokens ?? 0,
      );
      if (input > 0 || output > 0) return { input, output };
    }
    return {
      input: estimateTokens(args),
      output: estimateTokens(
        contentText((result as { content?: unknown }).content),
      ),
    };
  }
  return { input: estimateTokens(args), output: 0 };
}

function costCentsFor(
  model: ModelHandle,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = model.settings.pricing;
  if (pricing === null) return null;
  return Math.round(
    (inputTokens / 1_000_000) * pricing.inputCentsPerMTok +
      (outputTokens / 1_000_000) * pricing.outputCentsPerMTok,
  );
}

export interface MeterOptions {
  kind: UsageKind;
  jobId: JobId | null;
  conversationId?: ConversationId | null;
  checkSignal?: () => void;
  role: ModelRole;
  signal: AbortSignal;
  gate: ModelGate;
  usage: UsageMeter;
}

function boundMember(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  return typeof value === "function"
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

function instrumentChat(
  base: ChatModelLike,
  model: ModelHandle,
  options: MeterOptions,
): ChatModelLike {
  const assertSignal = (): void => {
    if (options.checkSignal) options.checkSignal();
    else if (options.signal.aborted)
      throw new DOMException("已停止生成", "AbortError");
  };
  const invoke = (target: object, args: unknown[]): Promise<unknown> =>
    options.gate.run(options.role, async () => {
      assertSignal();
      const promptTokens = estimateTokens(args[0]);
      const allowed = options.usage.canSpend({
        kind: options.kind,
        estimatedCalls: 1,
        estimatedInputTokens: promptTokens,
        estimatedOutputTokens: model.settings.maxOutputTokens,
      });
      if (!allowed)
        throw new LearningError("budget_exhausted", "模型配额已用尽", {
          kind: options.kind,
        });
      const callable = target as {
        invoke: (...a: never[]) => Promise<unknown>;
      };
      // Pass cancellation to the provider, not just to the display stream.
      const callArgs = [...args];
      callArgs[1] = {
        ...(typeof args[1] === "object" && args[1] !== null ? args[1] : {}),
        signal: options.signal,
      };
      const record = (result: unknown): void => {
        const { input, output } = tokensOf(result, args);
        options.usage.record({
          kind: options.kind,
          jobId: options.jobId,
          conversationId: options.conversationId ?? null,
          provider: model.settings.provider,
          model: model.modelId,
          inputTokens: input,
          outputTokens: output,
          calls: 1,
          costCents: costCentsFor(model, input, output),
        });
      };
      let result: unknown;
      try {
        result = await callable.invoke(...(callArgs as never[]));
      } catch (error) {
        record(error);
        throw error;
      }
      record(result);
      assertSignal();
      return result;
    });

  const wrapRunnable = (bound: object): object =>
    new Proxy(bound, {
      get(target, prop) {
        if (prop === "invoke") {
          return (...args: unknown[]) => invoke(target, args);
        }
        if (prop === "stream") {
          return (...args: unknown[]) => invoke(target, args);
        }
        return boundMember(target, prop);
      },
    });

  return new Proxy(base, {
    get(target, prop) {
      if (prop === "invoke" || prop === "stream") {
        return (...args: unknown[]) => invoke(target, args);
      }
      if (prop === "bindTools") {
        return (...args: unknown[]) => {
          const bind = Reflect.get(target, "bindTools", target) as (
            ...a: unknown[]
          ) => object;
          return wrapRunnable(bind.apply(target, args));
        };
      }
      return boundMember(target, prop);
    },
  });
}

export function meteredHandle(
  model: ModelHandle,
  options: MeterOptions,
): ModelHandle {
  return {
    modelId: model.modelId,
    settings: model.settings,
    estimate: (role, promptTokens) => model.estimate(role, promptTokens),
    chat: () => instrumentChat(model.chat(), model, options),
  };
}

const gates = new WeakMap<Database, ModelGate>();
export function modelGateFor(db: Database): ModelGate {
  let gate = gates.get(db);
  if (!gate) {
    gate = createModelGate();
    gates.set(db, gate);
  }
  return gate;
}
