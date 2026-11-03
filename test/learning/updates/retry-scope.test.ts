import { afterEach, describe, expect, it } from "vitest";

import {
  changeEventIdFromKey,
  type JobId,
  type JobRecord,
} from "../../../src/learning/contracts/index.ts";
import {
  cleanupHarness,
  createRealRunner,
  createUpdateHarness,
  manualChangeJob,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-19: retry accepts only failed/cancelled/interrupted; completed and
 * running jobs are `job_not_retryable`; the attempt increments and no event is
 * added.
 */
describe("change job retry scope", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  function seedJob(state: "completed" | "running", id: string): JobId {
    const jobId = id as JobId;
    harness!.repos.jobs.insert({
      jobId,
      dedupeKey: `dk-${id}`,
      kind: "change_analysis",
      repoId: harness!.repo.repoId,
      projectId: harness!.project.projectId,
      streamId: null,
      state,
      payload: {
        kind: "change",
        eventId: changeEventIdFromKey(`event-${id}`),
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        mergeBaseSha: "a".repeat(40),
        streamKind: "default_branch",
      },
      attempt: 0,
      errorCode: null,
      errorDetail: null,
      progress: null,
      outputGenerationId: null,
      createdAt: harness!.clock.now().toISOString(),
      startedAt: harness!.clock.now().toISOString(),
      finishedAt:
        state === "completed" ? harness!.clock.now().toISOString() : null,
    });
    return jobId;
  }

  it("retries a failed change job without adding events", async () => {
    harness = await createUpdateHarness();
    const { runner } = createRealRunner(harness);
    const head = harness.git.head("main");
    const eventId = changeEventIdFromKey("retry-event");
    const enqueued = await runner.enqueue(
      manualChangeJob(harness, eventId, "manual:retry", head),
    );
    await runner.drain();

    const failed = harness.repos.jobs.byId(enqueued.jobId) as JobRecord;
    expect(failed.state).toBe("failed");
    const eventsBefore = harness.events().length;

    const retried = await runner.retry(enqueued.jobId);
    expect(retried.state).toBe("queued");
    expect(retried.attempt).toBeGreaterThan(failed.attempt);
    await runner.drain();
    expect(harness.events()).toHaveLength(eventsBefore);
  });

  it("rejects retry for completed and running jobs", async () => {
    harness = await createUpdateHarness();
    const { runner } = createRealRunner(harness);
    const completed = seedJob("completed", "j_completed_test");
    const running = seedJob("running", "j_running_test");
    await expect(runner.retry(completed)).rejects.toMatchObject({
      code: "job_not_retryable",
    });
    void running;
    await expect(runner.retry(running)).rejects.toMatchObject({
      code: "job_not_retryable",
    });
    expect(harness.events()).toHaveLength(0);
  });
});
