/**
 * Usage accounting (architecture §3.13 `UsageMeter`, §20).
 *
 * `record` is called once per completed provider call, including calls that were
 * in flight when a job was cancelled: the row is written before the abort is
 * observed, so consumed spend is never lost.
 *
 * `canSpend` is the pre-flight quota gate. It is **pure** — it reads the stored
 * totals and the configured quota and never mutates either — so the caller can
 * fail with `budget_exhausted` before issuing a request (AC-GEN-20).
 */

import { randomUUID } from "node:crypto";

import type {
  Clock,
  Database,
  Repositories,
  UsageKind,
  UsageMeter,
} from "../contracts/index.js";

// Declared in contracts/ports.ts (§3.13); re-export only.
export type { UsageMeter } from "../contracts/index.js";

function usageId(): string {
  return `u_${randomUUID().replace(/-/gu, "")}`;
}

export function createUsageMeter(deps: {
  db: Database;
  repos: Repositories;
  clock: Clock;
}): UsageMeter {
  const { repos, clock } = deps;

  const totals = (kind?: UsageKind): ReturnType<UsageMeter["totals"]> => {
    const groups = repos.usage.groupByKind(kind);
    const calls = groups.reduce((sum, group) => sum + group.calls, 0);
    const inputTokens = groups.reduce(
      (sum, group) => sum + group.inputTokens,
      0,
    );
    const outputTokens = groups.reduce(
      (sum, group) => sum + group.outputTokens,
      0,
    );
    const priced = groups.filter((group) => group.costCents !== null);
    const costCents =
      groups.length === 0 || priced.length === 0
        ? null
        : priced.reduce((sum, group) => sum + (group.costCents ?? 0), 0);
    return { calls, inputTokens, outputTokens, costCents };
  };

  return {
    record(input): void {
      repos.usage.insert({
        usageId: usageId(),
        jobId: input.jobId,
        conversationId: input.conversationId,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        calls: input.calls,
        costCents: input.costCents,
        createdAt: clock.now().toISOString(),
      });
    },

    canSpend(input): boolean {
      const settings = repos.settings.model();
      // No configured model ⇒ no quota is known; the job's own model check
      // (model_not_configured) is the gate that applies.
      if (settings === null) return true;
      const quota = settings.quota;
      const used = totals(input.kind);
      const maxCalls = quota.maxCalls;
      const maxInput = quota.maxInputTokens;
      const maxOutput = quota.maxOutputTokens;
      if (maxCalls > 0 && used.calls + input.estimatedCalls > maxCalls) {
        return false;
      }
      if (
        maxInput > 0 &&
        used.inputTokens + input.estimatedInputTokens > maxInput
      ) {
        return false;
      }
      if (
        maxOutput > 0 &&
        used.outputTokens + input.estimatedOutputTokens > maxOutput
      ) {
        return false;
      }
      return true;
    },

    totals,
  };
}
