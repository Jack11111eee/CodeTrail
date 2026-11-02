/**
 * Deterministic scripted chat model (architecture §17.1, PRD §15.2 item 1).
 *
 * The provider is a real `BaseChatModel`, so agent runners drive it exactly as
 * they drive a hosted provider, but every response comes from a JSON script on
 * disk. There is no randomness, no wall-clock input and no network access: the
 * only I/O is one `fs` read under `options.dir` per model instance.
 *
 * A script is keyed by `(workerKind, pagePath, promptTemplateVersion)`. The
 * `workerKind` comes from the tools offered through `bindTools` — `submit_plan`
 * means the planner, `submit_page` the page worker, otherwise the owning role
 * (`lesson` | `qa` | `change`). `pagePath` is the `/openwiki/<path>.md` named by
 * the system message. The n-th call for a key consumes the entry whose
 * `occurrence` is n; a missing entry is a loud `fixture_missing` failure rather
 * than an empty response.
 */

import fs from "node:fs";
import path from "node:path";

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";

import { LearningError } from "../contracts/index.js";
import type { ModelRole } from "../contracts/index.js";

export type { Clock } from "./clock.js";

/** The roles a script entry can answer for. */
export type ScriptWorkerKind = "planner" | "page" | "lesson" | "qa" | "change";

export interface ScriptToolCall {
  name: string;
  args: unknown;
}

export interface ScriptStep {
  toolCalls?: ScriptToolCall[];
  content?: string;
}

export interface ScriptEntry {
  workerKind: ScriptWorkerKind;
  pagePath?: string;
  promptTemplateVersion?: string;
  /** 1-based ordinal of the call for this key; defaults to 1. */
  occurrence?: number;
  steps: ScriptStep[];
}

export interface ScriptFile {
  scripts: ScriptEntry[];
}

export interface ScriptedModelOptions {
  dir: string;
  role: ModelRole;
  promptTemplateVersion: string;
  onCall?: (info: {
    role: ModelRole;
    tools: string[];
    inputTokens: number;
    outputTokens: number;
  }) => void;
}

/** File name read from `options.dir`; a directory holding scripted fixtures. */
export const SCRIPT_FILE_NAME = "scripts.json";

const WORKER_KINDS: ReadonlySet<string> = new Set([
  "planner",
  "page",
  "lesson",
  "qa",
  "change",
]);

const OPENWIKI_PAGE_PATH = /\/openwiki\/([^\s"'`<>]+?)\.md/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFixture(
  file: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new LearningError("invalid_input", `${message} (${file})`, {
    file,
    ...details,
  });
}

function parseStep(raw: unknown, file: string, index: number): ScriptStep {
  if (!isRecord(raw)) {
    invalidFixture(file, "script step must be an object", { index });
  }
  const step: ScriptStep = {};
  if (raw.content !== undefined) {
    if (typeof raw.content !== "string") {
      invalidFixture(file, "script step content must be a string", { index });
    }
    step.content = raw.content;
  }
  if (raw.toolCalls !== undefined) {
    if (!Array.isArray(raw.toolCalls)) {
      invalidFixture(file, "script step toolCalls must be an array", { index });
    }
    step.toolCalls = raw.toolCalls.map(
      (rawCall: unknown, callIndex: number) => {
        if (!isRecord(rawCall)) {
          invalidFixture(file, "tool call must be an object", {
            index,
            callIndex,
          });
        }
        if (typeof rawCall.name !== "string" || rawCall.name === "") {
          invalidFixture(file, "tool call name must be a non-empty string", {
            index,
            callIndex,
          });
        }
        if (!isRecord(rawCall.args)) {
          invalidFixture(file, "tool call args must be an object", {
            index,
            callIndex,
          });
        }
        return { name: rawCall.name, args: rawCall.args };
      },
    );
  }
  return step;
}

function parseEntry(raw: unknown, file: string, index: number): ScriptEntry {
  if (!isRecord(raw)) {
    invalidFixture(file, "script entry must be an object", { index });
  }
  if (typeof raw.workerKind !== "string" || !WORKER_KINDS.has(raw.workerKind)) {
    invalidFixture(file, "script entry workerKind is not recognised", {
      index,
      workerKind: raw.workerKind,
    });
  }
  const entry: ScriptEntry = {
    workerKind: raw.workerKind as ScriptWorkerKind,
    steps: [],
  };
  if (raw.pagePath !== undefined) {
    if (typeof raw.pagePath !== "string") {
      invalidFixture(file, "script entry pagePath must be a string", { index });
    }
    entry.pagePath = raw.pagePath;
  }
  if (raw.promptTemplateVersion !== undefined) {
    if (typeof raw.promptTemplateVersion !== "string") {
      invalidFixture(
        file,
        "script entry promptTemplateVersion must be a string",
        { index },
      );
    }
    entry.promptTemplateVersion = raw.promptTemplateVersion;
  }
  if (raw.occurrence !== undefined) {
    if (
      typeof raw.occurrence !== "number" ||
      !Number.isSafeInteger(raw.occurrence) ||
      raw.occurrence < 1
    ) {
      invalidFixture(
        file,
        "script entry occurrence must be a positive integer",
        { index, occurrence: raw.occurrence },
      );
    }
    entry.occurrence = raw.occurrence;
  }
  if (!Array.isArray(raw.steps)) {
    invalidFixture(file, "script entry steps must be an array", { index });
  }
  entry.steps = raw.steps.map((step: unknown, stepIndex: number) =>
    parseStep(step, file, stepIndex),
  );
  return entry;
}

/** Reads and validates the script file once per model instance. */
function loadScriptFile(dir: string): ScriptFile {
  const file = dir.endsWith(".json")
    ? path.resolve(dir)
    : path.resolve(dir, SCRIPT_FILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new LearningError(
      "internal_error",
      `scripted model fixture is missing: ${file}`,
      {
        reason: "fixture_missing",
        file,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    invalidFixture(file, "scripted model fixture is not valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.scripts)) {
    invalidFixture(file, "scripted model fixture must be { scripts: [] }");
  }

  const seen = new Set<string>();
  const scripts = parsed.scripts.map((entry: unknown, index: number) => {
    const parsedEntry = parseEntry(entry, file, index);
    const key = [
      parsedEntry.workerKind,
      parsedEntry.pagePath ?? "",
      parsedEntry.promptTemplateVersion ?? "*",
      String(parsedEntry.occurrence ?? 1),
    ].join("\u0000");
    if (seen.has(key)) {
      invalidFixture(file, "duplicate occurrence for scripted model key", {
        index,
        workerKind: parsedEntry.workerKind,
        pagePath: parsedEntry.pagePath ?? null,
        promptTemplateVersion: parsedEntry.promptTemplateVersion ?? null,
        occurrence: parsedEntry.occurrence ?? 1,
      });
    }
    seen.add(key);
    return parsedEntry;
  });

  return { scripts };
}

/** Extracts plain text from a message content value (string or text blocks). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (isRecord(block) && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** The `/openwiki/<path>.md` named by the system message, if any. */
function extractPagePath(messages: BaseMessage[]): string | null {
  for (const message of messages) {
    if (message._getType() !== "system") continue;
    const match = OPENWIKI_PAGE_PATH.exec(contentText(message.content));
    if (match !== null) return match[1];
  }
  return null;
}

/** Best-effort tool name for every shape `bindTools` accepts. */
function toolNameOf(tool: BindToolsInput): string | null {
  const candidate: unknown = tool;
  if (typeof candidate === "string") {
    return candidate === "" ? null : candidate;
  }
  if (!isRecord(candidate)) return null;
  if (typeof candidate.name === "string" && candidate.name !== "") {
    return candidate.name;
  }
  if (isRecord(candidate.function)) {
    const name = candidate.function.name;
    if (typeof name === "string" && name !== "") return name;
  }
  return null;
}

function workerKindFor(
  tools: readonly string[],
  role: ModelRole,
): ScriptWorkerKind {
  if (tools.includes("submit_plan")) return "planner";
  if (tools.includes("submit_page")) return "page";
  switch (role) {
    case "lesson":
    case "qa":
    case "change":
      return role;
    case "repo_job":
      return "planner";
    case "page_worker":
      return "page";
  }
}

function occurrenceOf(entry: ScriptEntry): number {
  return entry.occurrence ?? 1;
}

function specificityOf(entry: ScriptEntry): number {
  return (
    (entry.pagePath === undefined ? 0 : 2) +
    (entry.promptTemplateVersion === undefined ? 0 : 1)
  );
}

/** Deterministic token estimate: whitespace-independent, never negative. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toolMetrics(step: ScriptStep): string {
  const calls = step.toolCalls ?? [];
  return calls
    .map((call) => `${call.name}:${JSON.stringify(call.args)}`)
    .join("\n");
}

class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly modelOptions: ScriptedModelOptions;
  private readonly callCounts = new Map<string, number>();
  private offeredTools: string[] = [];
  private script: ScriptFile | null = null;
  private toolCallSeq = 0;

  constructor(fields: ScriptedModelOptions) {
    super({});
    this.modelOptions = fields;
  }

  _llmType(): string {
    return "codetrail-scripted";
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>,
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    BaseChatModelCallOptions
  > {
    this.offeredTools = tools
      .map(toolNameOf)
      .filter((name): name is string => name !== null);
    // `BaseChatModel` leaves `bindTools` to concrete providers; binding the
    // tools as call options is what every provider implementation does, and it
    // is how the mock receives them back in `_generate`.
    return this.withConfig({
      tools,
      ...(kwargs ?? {}),
    } as Partial<BaseChatModelCallOptions>);
  }

  private loadScript(): ScriptFile {
    if (this.script === null) {
      this.script = loadScriptFile(this.modelOptions.dir);
    }
    return this.script;
  }

  private offeredToolNames(options: Record<string, unknown>): string[] {
    if (this.offeredTools.length > 0) return this.offeredTools;
    const raw = options.tools;
    if (!Array.isArray(raw)) return [];
    const names: string[] = [];
    for (const tool of raw as BindToolsInput[]) {
      const name = toolNameOf(tool);
      if (name !== null) names.push(name);
    }
    return names;
  }

  private selectEntry(
    workerKind: ScriptWorkerKind,
    pagePath: string | null,
    version: string,
    occurrence: number,
  ): ScriptEntry {
    const matches = this.loadScript().scripts.filter(
      (entry) =>
        entry.workerKind === workerKind &&
        (entry.pagePath === undefined || entry.pagePath === pagePath) &&
        (entry.promptTemplateVersion === undefined ||
          entry.promptTemplateVersion === version) &&
        occurrenceOf(entry) === occurrence,
    );
    if (matches.length === 0) {
      throw new LearningError(
        "internal_error",
        `scripted model has no fixture for ${workerKind}/${pagePath ?? "(no page)"}/` +
          `${version} occurrence ${occurrence}`,
        {
          reason: "fixture_missing",
          workerKind,
          pagePath,
          promptTemplateVersion: version,
          occurrence,
        },
      );
    }
    matches.sort((a, b) => specificityOf(b) - specificityOf(a));
    if (
      matches.length > 1 &&
      specificityOf(matches[0]) === specificityOf(matches[1])
    ) {
      throw new LearningError(
        "invalid_input",
        "ambiguous scripted model fixture: duplicate occurrence",
        {
          workerKind,
          pagePath,
          promptTemplateVersion: version,
          occurrence,
        },
      );
    }
    const entry = matches[0];
    if (entry.steps.length === 0) {
      throw new LearningError(
        "internal_error",
        `scripted model fixture for ${workerKind}/${pagePath ?? "(no page)"}/` +
          `${version} occurrence ${occurrence} has no step`,
        {
          reason: "fixture_missing",
          workerKind,
          pagePath,
          promptTemplateVersion: version,
          occurrence,
        },
      );
    }
    return entry;
  }

  _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const tools = this.offeredToolNames(options);
    const workerKind = workerKindFor(tools, this.modelOptions.role);
    const pagePath = extractPagePath(messages);
    const version = this.modelOptions.promptTemplateVersion;
    const key = `${workerKind}\u0000${pagePath ?? ""}\u0000${version}`;
    const callNumber = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, callNumber);

    const entry = this.selectEntry(workerKind, pagePath, version, callNumber);
    const step = entry.steps[0];
    const content = step.content ?? "";
    const toolCalls = (step.toolCalls ?? []).map((call) => {
      this.toolCallSeq += 1;
      return {
        name: call.name,
        args: call.args as Record<string, unknown>,
        id: `call_${this.toolCallSeq}`,
        type: "tool_call" as const,
      };
    });
    const message = new AIMessage({
      content,
      tool_calls: toolCalls.length === 0 ? undefined : toolCalls,
    });

    const inputText = messages
      .map((message) => contentText(message.content))
      .join("\n");
    const outputText = `${content}\n${toolMetrics(step)}`;
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(outputText);

    this.modelOptions.onCall?.({
      role: this.modelOptions.role,
      tools,
      inputTokens,
      outputTokens,
    });

    return Promise.resolve({
      generations: [{ text: content, message }],
      llmOutput: {
        tokenUsage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      },
    });
  }
}

/** Builds the deterministic `BaseChatModel` used by every learning test. */
export function createScriptedModel(
  options: ScriptedModelOptions,
): BaseChatModel {
  if (typeof options.dir !== "string" || options.dir.trim() === "") {
    throw new LearningError(
      "invalid_input",
      "scripted model requires a fixture directory",
      { field: "dir" },
    );
  }
  return new ScriptedChatModel(options);
}
