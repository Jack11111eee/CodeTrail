import { existsSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import {
  changeEventIdFromKey,
  type ChangeEventId,
  type ChangeEventKind,
  type Lesson,
  type LessonBuilderPort,
  type ModelSettings,
  type ProjectId,
  type StreamKind,
} from "../../../src/learning/contracts/index.ts";
import { stagingPath } from "../../../src/learning/config/paths.ts";
import {
  comparisonInput,
  createHarness,
  DEFAULT_SETTINGS,
  generationInput,
  runToCompletion,
  sampleLesson,
  SHA_A,
  SHA_B,
  type Harness,
} from "../generation/harness.ts";

/**
 * Integration boundary introduced by the level-13 merge.
 *
 * The only production change in this merge is `assertBudgetAvailable` in
 * `src/learning/api/jobs/pipeline.ts`: a job-level quota pre-flight added to
 * the generation, comparison and change pipelines. Its whole reason to exist is
 * the interaction between three separately-owned components:
 *
 *   job runner  →  pipeline dispatch  →  UsageMeter.canSpend
 *                              ↘  Publisher.buildWorkspace / SnapshotService
 *
 * The per-call gate in `instrumentChat` is the real limit, but an agent-driven
 * run goes through the upstream graph, which rewraps the thrown
 * `LearningError` and loses its `budget_exhausted` code. Without the pre-flight
 * the job surfaces as `internal_error`. These tests therefore assert the
 * *cross-component* contract, not the meter in isolation:
 *
 *  - a refused job fails with `budget_exhausted` (not `internal_error`);
 *  - nothing is dispatched: zero model calls;
 *  - no staging workspace is created and no generation is published;
 *  - already-recorded usage is neither reset nor re-counted;
 *  - the failure stays retryable, and retrying after raising the quota
 *    completes the same job identity.
 *
 * The comparison and change pipelines are exercised explicitly because the
 * acceptance F10 flow only drives dispatch-time exhaustion for a generation
 * job; these two pre-flight call sites would otherwise have no integration
 * coverage at all.
 */

const harnesses: Harness[] = [];
const PROJECT_ID = "p_quota_preflight" as ProjectId;

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function exhaustedSettings(maxCalls: number): ModelSettings {
  return {
    ...DEFAULT_SETTINGS,
    quota: {
      maxCalls,
      maxInputTokens: 10_000_000,
      maxOutputTokens: 10_000_000,
    },
  };
}

/**
 * Pre-charges the meter with `calls` calls of `kind` and pins the persisted
 * quota to exactly that spend, so the *next* dispatch must be refused.
 */
function exhaustBudget(
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
  harness.repos.settings.putModel(exhaustedSettings(calls));
}

function generationCount(harness: Harness): number {
  const row = harness.db.raw
    .prepare("SELECT COUNT(*) AS n FROM generations")
    .get() as { n: number };
  return row.n;
}

function assertNoDispatch(
  harness: Harness,
  job: { jobId: string },
  expectedGenerations: number,
): void {
  // No model request reached the provider…
  expect(harness.calls.count, "no model call may be issued").toBe(0);
  // …and no build area was opened, so GC has nothing to reclaim and the
  // publisher never saw a staged tree.
  expect(
    existsSync(stagingPath(harness.paths, job.jobId as never)),
    "a refused job must not create a staging workspace",
  ).toBe(false);
  expect(generationCount(harness), "nothing may be published").toBe(
    expectedGenerations,
  );
}

/** The change-event table requires a real project; insert it once. */
function ensureProject(harness: Harness): ProjectId {
  if (harness.repos.projects.byId(PROJECT_ID) === null) {
    harness.repos.projects.insert({
      projectId: PROJECT_ID,
      repoId: harness.repoId,
      kind: "local",
      displayName: "quota-preflight",
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
    baseSha?: string;
    headSha?: string;
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
      baseSha: options.baseSha ?? SHA_A,
      headSha: options.headSha ?? SHA_B,
      mergeBaseSha: options.baseSha ?? SHA_A,
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

/**
 * The shared harness change builder never calls the model, so it cannot show
 * which usage bucket a change job writes to. This builder drives the *metered*
 * handle once and then returns the same lesson shape the harness produces.
 */
function changeBuilderCallingModel(): LessonBuilderPort {
  return {
    async buildResearchLessons() {
      throw new Error("research builder is not used by this test");
    },
    async buildChangeLesson(input) {
      const chat = input.model.chat() as unknown as {
        invoke: (prompt: string) => Promise<unknown>;
      };
      await chat.invoke("explain the change");
      const ref = await input.registry.registerRepo({
        generationId: input.generation.generationId,
        repoId: input.generation.repoId,
        commitSha: input.generation.commitSha,
        path: "src/index.ts",
        lines: null,
        snapshot: input.headSnapshot,
        scope: input.scope,
      });
      const lesson = sampleLesson(
        "change",
        input.generation,
        [ref.sourceId],
        {
          repoId: input.generation.repoId,
          commitSha: input.generation.commitSha,
          generationId: input.generation.generationId,
          scenarioId: "sc_test",
          moduleIds: ["src"],
        },
      ) as unknown as Record<string, unknown>;
      lesson.eventId = input.event.eventId;
      lesson.behaviorChange = { before: "before", after: "after" };
      lesson.affectedModules = [];
      lesson.keyTechnologies = [];
      lesson.alternatives = [];
      lesson.unverifiedEffects = [];
      lesson.omittedReasons = {};
      return {
        lessons: [lesson as unknown as Lesson],
        failures: [],
        blankTeaching: false,
      };
    },
    async buildComparisonLesson() {
      throw new Error("comparison builder is not used by this test");
    },
  };
}

describe("quota pre-flight at the job/pipeline boundary", () => {
  test("generation_initial is refused as budget_exhausted before any dispatch", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    exhaustBudget(harness, "initial", 2);
    const beforeUsage = harness.usage.totals("initial");
    const beforeGenerations = generationCount(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );

    expect(job.state).toBe("failed");
    // The upstream graph rewraps a thrown LearningError, so without the
    // pre-flight this would be `internal_error`. The code must survive.
    expect(job.errorCode).toBe("budget_exhausted");
    expect(job.errorDetail ?? "").toContain("配额");
    expect(job.outputGenerationId).toBeNull();
    assertNoDispatch(harness, job, beforeGenerations);
    // Consumed spend is not cleared by the refusal.
    expect(harness.usage.totals("initial")).toEqual(beforeUsage);
  });

  test("generation_update is refused using the update usage kind", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    exhaustBudget(harness, "update", 1);
    const beforeGenerations = generationCount(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_B, mode: "update" }),
    );

    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    assertNoDispatch(harness, job, beforeGenerations);
  });

  test("comparison is refused before its staging workspace exists", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    exhaustBudget(harness, "comparison", 1);
    const beforeGenerations = generationCount(harness);

    const job = await runToCompletion(
      harness,
      comparisonInput(harness, { baseSha: SHA_A, headSha: SHA_B }),
    );

    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    expect(job.errorDetail ?? "").toContain("配额");
    assertNoDispatch(harness, job, beforeGenerations);
  });

  test("change_analysis is refused before its staging workspace exists", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    exhaustBudget(harness, "change", 1);
    const beforeGenerations = generationCount(harness);
    const eventId = changeEventIdFromKey("budget-change-event");
    seedChangeEvent(harness, {
      eventId,
      eventKey: "budget-change-event",
      streamId: "manual:budget-change",
    });

    const job = await runToCompletion(
      harness,
      changeJobInput(harness, eventId, "manual:budget-change"),
    );

    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    assertNoDispatch(harness, job, beforeGenerations);
    // The discovered event survives the refused analysis (it is not lost).
    expect(harness.repos.changes.byId(eventId)?.eventId).toBe(eventId);
  });

  test("a change job that is allowed records usage under the change kind", async () => {
    const harness = await createHarness({
      lessonBuilder: changeBuilderCallingModel(),
    });
    harnesses.push(harness);
    const eventId = changeEventIdFromKey("allowed-change-event");
    seedChangeEvent(harness, {
      eventId,
      eventKey: "allowed-change-event",
      streamId: "manual:allowed-change",
    });

    const job = await runToCompletion(
      harness,
      changeJobInput(harness, eventId, "manual:allowed-change"),
    );

    expect(job.state).toBe("completed");
    expect(job.errorCode).toBeNull();
    // The `kind: "change"` → `kind: usageKind` refactor must not move the
    // recorded usage to another bucket.
    expect(harness.usage.totals("change").calls).toBeGreaterThan(0);
    expect(harness.usage.totals("initial").calls).toBe(0);
    expect(harness.usage.totals("update").calls).toBe(0);
    expect(generationCount(harness)).toBe(1);
  });

  test("raising the quota lets the same failed job retry to completion", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    exhaustBudget(harness, "initial", 1);
    const failed = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(failed.errorCode).toBe("budget_exhausted");
    expect(harness.calls.count).toBe(0);

    // Operator raises the quota; the retry keeps the job identity.
    harness.repos.settings.putModel(exhaustedSettings(10));
    const retried = await harness.runner.retry(failed.jobId);
    expect(retried.jobId).toBe(failed.jobId);
    expect(retried.attempt).toBe(2);
    await harness.runner.drain();

    const finished = (await harness.runner.get(failed.jobId))!;
    expect(finished.state).toBe("completed");
    expect(finished.errorCode).toBeNull();
    expect(finished.outputGenerationId).not.toBeNull();
    expect(harness.usage.totals("initial").calls).toBeGreaterThan(1);
    expect(generationCount(harness)).toBe(1);
  });

  test("a repeat enqueue is served from the completed cache despite an exhausted quota", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const input = generationInput(harness, { sha: SHA_A });
    const first = await runToCompletion(harness, input);
    expect(first.state).toBe("completed");
    const callsAfterFirst = harness.calls.count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Pin the quota to exactly what the first run consumed.
    exhaustBudget(harness, "initial", harness.usage.totals("initial").calls);

    const again = await harness.runner.enqueue(input);
    await harness.runner.drain();

    // The idempotent enqueue returns the same completed job: a cached repeat
    // must not be turned into a budget failure and must not call the model.
    expect(again.jobId).toBe(first.jobId);
    expect(again.state).toBe("completed");
    expect(again.errorCode).toBeNull();
    expect(harness.calls.count).toBe(callsAfterFirst);
    expect(generationCount(harness)).toBe(1);
  });
});
