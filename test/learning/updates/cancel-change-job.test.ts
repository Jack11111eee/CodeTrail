import { afterEach, describe, expect, it } from "vitest";

import {
  changeEventIdFromKey,
  type ChangeEventId,
} from "../../../src/learning/contracts/index.ts";
import { reconcileEventStates } from "../../../src/learning/updates/discovery.ts";
import {
  cleanupHarness,
  createRealRunner,
  createUpdateHarness,
  manualChangeJob,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-20: cancelling a change analysis keeps the event in a cancelled
 * state, publishes nothing, makes later events in the stream `waiting`, and
 * retry recovers.
 */
describe("cancel a change job", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  function seedEvent(
    eventId: ChangeEventId,
    eventKey: string,
    streamId: string,
    headSha: string,
    jobId: string | null,
    state: "queued" | "waiting",
  ): void {
    harness!.repos.changes.insertMany([
      {
        eventId,
        eventKey,
        repoId: harness!.repo.repoId,
        projectId: harness!.project.projectId,
        streamId,
        streamKind: "default_branch",
        kind: "commit",
        baseSha: headSha,
        headSha,
        mergeBaseSha: headSha,
        baseContextSha: null,
        significance: "full",
        state,
        jobId: jobId as never,
        gapReason: null,
        linkedEventId: null,
        linkRelation: null,
        discoveredAt: harness!.clock.now().toISOString(),
        publishedAt: null,
        payload: {},
      },
    ]);
  }

  it("cancels, parks successors and retries without publishing", async () => {
    harness = await createUpdateHarness();
    const { runner } = createRealRunner(harness);
    const head = harness.git.head("main");
    const streamId = "manual:cancel";
    const eventId = changeEventIdFromKey("cancel-event");
    const job = await runner.enqueue(
      manualChangeJob(harness, eventId, streamId, head),
    );
    seedEvent(eventId, "cancel-event", streamId, head, job.jobId, "queued");

    const cancelled = await runner.cancel(job.jobId);
    expect(cancelled.state).toBe("cancelled");

    reconcileEventStates(harness.repos, harness.project.projectId);
    expect(harness.repos.changes.byId(eventId)?.state).toBe("cancelled");
    expect(
      harness.repos.generations.listByProject(harness.project.projectId),
    ).toHaveLength(0);

    // A later event in the same stream waits.
    harness.clock.advance(1_000);
    const laterId = changeEventIdFromKey("later-event");
    seedEvent(laterId, "later-event", streamId, head, null, "queued");
    reconcileEventStates(harness.repos, harness.project.projectId);
    expect(harness.repos.changes.byId(laterId)?.state).toBe("waiting");

    // Retry recovers the same job; no event is added.
    const before = harness.events().length;
    const retried = await runner.retry(job.jobId);
    expect(retried.state).toBe("queued");
    expect(retried.attempt).toBeGreaterThan(0);
    await runner.cancel(job.jobId);
    await runner.drain();
    expect(harness.events()).toHaveLength(before);
    expect(
      harness.repos.generations.listByProject(harness.project.projectId),
    ).toHaveLength(0);
  });
});
