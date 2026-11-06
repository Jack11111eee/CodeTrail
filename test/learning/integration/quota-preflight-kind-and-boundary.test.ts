import { afterEach, describe, expect, test } from "vitest";

import {
  changeEventIdFromKey,
  type ChangeEventId,
  type ChangeEventKind,
  type ModelSettings,
  type ProjectId,
  type StreamKind,
} from "../../../src/learning/contracts/index.ts";
import {
  comparisonInput,
  createHarness,
  DEFAULT_SETTINGS,
  generationInput,
  runToCompletion,
  SHA_A,
  SHA_B,
  type Harness,
} from "../generation/harness.ts";

/**
 * Integration boundary introduced by the level-13 merge (issue-33).
 *
 * The only production change in this merge is `assertBudgetAvailable` in
 * `src/learning/api/jobs/pipeline.ts`, wired into the generation, comparison
 * and change pipelines. The sibling integration suite
 * (`quota-preflight-job-pipelines.test.ts`) pins the headline contract: a
 * refused job fails with `budget_exhausted`, dispatches no model call and opens
 * no staging workspace.
 *
 * This file covers the *interaction* the headline suite leaves implicit:
 *
 *   job.kind → usageKindFor() → UsageMeter.canSpend(kind)
 *
 * The pre-flight is only correct if it (a) checks the usage bucket the job will
 * actually write to, so one exhausted bucket never blocks an unrelated one, and
 * (b) keeps the meter's documented strict-`>` boundary and pure read semantics.
 * A regression that passed the wrong `kind` (or mutated totals while probing)
 * would still pass the single-kind refusal tests, so these cases exist.
 */

const harnesses: Harness[] = [];
const PROJECT_ID = "p_quota_kind" as ProjectId;

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function settingsWithQuota(
  quota: Partial<ModelSettings["quota"]>,
): ModelSettings {
  return {
    ...DEFAULT_SETTINGS,
    quota: {
      maxCalls: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      ...quota,
    },
  };
}

function usageRows(harness: Harness): number {
  const row = harness.db.raw
    .prepare("SELECT COUNT(*) AS n FROM usage_records")
    .get() as { n: number };
  return row.n;
}

function generationCount(harness: Harness): number {
  const row = harness.db.raw
    .prepare("SELECT COUNT(*) AS n FROM generations")
    .get() as { n: number };
  return row.n;
}

function ensureProject(harness: Harness): ProjectId {
  if (harness.repos.projects.byId(PROJECT_ID) === null) {
    harness.repos.projects.insert({
      projectId: PROJECT_ID,
      repoId: harness.repoId,
      kind: "local",
      displayName: "quota-kind",
      remoteUrl: null,
      defaultBranch: "main",
      scope: harness.scope,
      watchEnabled: false,
      createdAt: harness.clock.now().toISOString(),
      deletedAt: null,
    });
  }
  return PROJECT_ID;
}

function seedChangeEvent(
  harness: Harness,
  options: {
    eventId: ChangeEventId;
    eventKey: string;
    streamId: string;
    streamKind?: StreamKind;
    kind?: ChangeEventKind;
  },
): void {
  harness.repos.changes.insertMany([
    {
      eventId: options.eventId,
      eventKey: options.eventKey,
      repoId: harness.repoId,
      projectId: ensureProject(harness),
      streamId: options.streamId,
      streamKind: options.streamKind ?? "default_branch",
      kind: options.kind ?? "commit",
      baseSha: SHA_A,
      headSha: SHA_B,
      mergeBaseSha: SHA_A,
      baseContextSha: null,
      significance: "full",
      state: "queued",
      jobId: null,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: harness.clock.now().toISOString(),
      publishedAt: null,
      payload: {},
    },
  ]);
}

function changeJobInput(
  harness: Harness,
  eventId: ChangeEventId,
  streamId: string,
) {
  return {
    kind: "change_analysis" as const,
    repoId: harness.repoId,
    projectId: ensureProject(harness),
    streamId,
    comparisonBaseSha: null,
    headSha: SHA_B,
    baseContextSha: SHA_A,
    scopeHash: harness.scope.hash,
    analysisConfigHash: harness.config.lessonPipelineVersion,
    payload: {
      kind: "change" as const,
      eventId,
      baseSha: SHA_A,
      headSha: SHA_B,
      mergeBaseSha: SHA_A,
      streamKind: "default_branch" as StreamKind,
    },
  };
}

/** Charges the meter with `calls` calls in `kind`, independent of the quota. */
function spend(
  harness: Harness,
  kind: "initial" | "update" | "comparison" | "change",
  calls: number,
): void {
  harness.usage.record({
    kind,
    jobId: null,
    conversationId: null,
    provider: "scripted",
    model: "scripted",
    inputTokens: 100 * calls,
    outputTokens: 100 * calls,
    calls,
    costCents: null,
  });
}

describe("quota pre-flight checks the job's own usage bucket", () => {
  test("an exhausted change bucket does not block an initial generation", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    spend(harness, "change", 3);
    harness.repos.settings.putModel(settingsWithQuota({ maxCalls: 3 }));
    // Precondition: the change bucket really is exhausted.
    expect(
      harness.usage.canSpend({
        kind: "change",
        estimatedCalls: 1,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 1024,
      }),
    ).toBe(false);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );

    expect(job.state, "an unrelated bucket must not block the job").toBe(
      "completed",
    );
    expect(job.errorCode).toBeNull();
    expect(harness.calls.count).toBeGreaterThan(0);
    expect(harness.usage.totals("initial").calls).toBeGreaterThan(0);
    expect(harness.usage.totals("change").calls).toBe(3);
  });

  test("an exhausted initial bucket does not block a change analysis", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    spend(harness, "initial", 3);
    harness.repos.settings.putModel(settingsWithQuota({ maxCalls: 3 }));
    const eventId = changeEventIdFromKey("kind-isolation-change");
    seedChangeEvent(harness, {
      eventId,
      eventKey: "kind-isolation-change",
      streamId: "manual:kind-isolation",
    });

    const job = await runToCompletion(
      harness,
      changeJobInput(harness, eventId, "manual:kind-isolation"),
    );

    expect(job.state, "change analysis uses the change bucket").toBe(
      "completed",
    );
    expect(job.errorCode).toBeNull();
    expect(harness.usage.totals("initial").calls).toBe(3);
  });

  test("an exhausted initial bucket does not block a comparison job", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    spend(harness, "initial", 2);
    harness.repos.settings.putModel(settingsWithQuota({ maxCalls: 2 }));

    const job = await runToCompletion(
      harness,
      comparisonInput(harness, { baseSha: SHA_A, headSha: SHA_B }),
    );

    expect(job.state).toBe("completed");
    expect(job.errorCode).toBeNull();
    expect(harness.usage.totals("initial").calls).toBe(2);
  });
});

describe("quota pre-flight honours token quotas, not just call counts", () => {
  test("an exhausted input-token quota refuses the job before dispatch", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    // Calls are unlimited; only the input-token budget is spent. The harness
    // model estimates 100 input tokens, so 50 left must be refused.
    harness.repos.settings.putModel(settingsWithQuota({ maxInputTokens: 50 }));

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );

    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    expect(harness.calls.count, "no model call may be issued").toBe(0);
    expect(generationCount(harness)).toBe(0);
  });

  test("an exhausted output-token quota refuses the job before dispatch", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    // The pre-flight reserves model.settings.maxOutputTokens (1024) per call;
    // a 500-token output budget can never fit one call.
    harness.repos.settings.putModel(
      settingsWithQuota({ maxOutputTokens: 500 }),
    );

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );

    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    expect(harness.calls.count).toBe(0);
  });
});

describe("quota pre-flight keeps the meter's documented boundary and purity", () => {
  test("a job that exactly fits the remaining call quota is allowed", async () => {
    // Exactly one model call so the job can finish on the same boundary the
    // pre-flight admitted (the per-call gate is not under test here).
    const harness = await createHarness({ callsFor: () => 1 });
    harnesses.push(harness);
    spend(harness, "initial", 2);
    // canSpend refuses only when used + estimate > max, so 2 + 1 == 3 passes.
    harness.repos.settings.putModel(settingsWithQuota({ maxCalls: 3 }));

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );

    expect(job.state, "the boundary itself is not an exhaustion").toBe(
      "completed",
    );
    expect(job.errorCode).toBeNull();
    expect(harness.calls.count).toBe(1);
  });

  test("a refused job neither resets nor adds usage rows", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    spend(harness, "initial", 1);
    harness.repos.settings.putModel(settingsWithQuota({ maxCalls: 1 }));
    const beforeTotals = harness.usage.totals("initial");
    const beforeRows = usageRows(harness);

    const first = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const second = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_B }),
    );

    expect(first.errorCode).toBe("budget_exhausted");
    expect(second.errorCode).toBe("budget_exhausted");
    // The pre-flight is a pure read: probing it twice changes nothing.
    expect(harness.usage.totals("initial")).toEqual(beforeTotals);
    expect(usageRows(harness)).toBe(beforeRows);
    expect(harness.calls.count).toBe(0);
  });
});
