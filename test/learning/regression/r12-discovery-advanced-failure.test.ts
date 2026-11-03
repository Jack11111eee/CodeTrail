/**
 * AC-R12-01: a discovery that advanced but whose generation failed is
 * recoverable. The event and its job stay addressable, the retry reuses the
 * same `job_id` with attempt 2, later events in the stream are parked as
 * `waiting`, another stream keeps moving, and the published cursor never
 * advances past the failure.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createRealRunner,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "../updates/harness.ts";

let harness: UpdateHarness | undefined;

afterEach(() => {
  cleanupHarness(harness);
  harness = undefined;
});

describe("AC-R12-01 — discovery advanced, generation failed", () => {
  it("keeps the event, retries the same job and parks successors", async () => {
    harness = await createUpdateHarness();
    await harness.tick();

    harness.clock.advance(60_000);
    harness.git.write("src/a.ts", "export const a = 1;\n");
    const commitA = harness.git.commit("feat: a");
    await harness.tick();

    const eventA = harness.events().find((event) => event.headSha === commitA);
    expect(eventA).toBeDefined();
    const jobA = harness.jobs().find((job) => job.jobId === eventA!.jobId);
    expect(jobA).toBeDefined();

    // The generation fails after discovery: the event is retained and its job
    // is terminal-failed, never deleted.
    harness.repos.jobs.transition(jobA!.jobId, ["queued"], "running", {
      startedAt: harness.clock.now().toISOString(),
      attempt: 1,
    });
    harness.repos.jobs.transition(jobA!.jobId, ["running"], "failed", {
      finishedAt: harness.clock.now().toISOString(),
      errorCode: "internal_error",
    });

    // A successor commit and a PR in another stream arrive in the same tick.
    harness.clock.advance(60_000);
    harness.git.write("src/b.ts", "export const b = 2;\n");
    const commitB = harness.git.commit("feat: b");
    const base = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const prHead = harness.git.commit("feat: feature");
    harness.git.checkout("main");
    harness.github.setPulls([
      makePull({
        number: 3,
        headSha: prHead,
        baseHeadSha: base,
        updatedAt: "2024-06-01T00:59:30.000Z",
      }),
    ]);
    await harness.tick();

    const byHead = (sha: string) =>
      harness!.events().find((event) => event.headSha === sha);
    expect(byHead(commitA)?.state).toBe("failed");
    expect(byHead(commitB)?.state).toBe("waiting");
    expect(byHead(commitB)?.jobId).toBeNull();
    expect(byHead(commitA)?.eventId).toBe(eventA!.eventId);
    // Another stream is not blocked by the failed default-branch event.
    expect(
      harness.events().find((event) => event.kind === "pull_request")?.state,
    ).toBe("queued");
    // Discovery advanced; the published cursor still lags behind it.
    expect(harness.discoveryCursor()?.headSha).toBe(commitB);
    expect(
      harness.repos.cursors.get(
        harness.repo.repoId,
        "default_branch",
        "published",
      ),
    ).toBeNull();

    // No double write: replaying the tick changes no event and no job.
    const eventIds = harness
      .events()
      .map((event) => event.eventId)
      .sort();
    const jobIds = harness
      .jobs()
      .map((job) => job.jobId)
      .sort();
    harness.clock.advance(10 * 60_000);
    await harness.tick();
    expect(
      harness
        .events()
        .map((event) => event.eventId)
        .sort(),
    ).toEqual(eventIds);
    expect(
      harness
        .jobs()
        .map((job) => job.jobId)
        .sort(),
    ).toEqual(jobIds);

    // Retry reuses the same job id and increments the attempt.
    const { runner } = createRealRunner(harness);
    const retried = await runner.retry(jobA!.jobId);
    expect(retried.jobId).toBe(jobA!.jobId);
    expect(retried.attempt).toBe(2);
    expect(retried.state).toBe("queued");
    await runner.drain();
    const afterRetry = await runner.get(jobA!.jobId);
    expect(afterRetry?.jobId).toBe(jobA!.jobId);
    expect(afterRetry?.attempt).toBe(2);
    expect(afterRetry?.state).toBe("failed");
    // The retry attempt is a real pipeline failure (no model configured), not
    // a silent success.
    expect(afterRetry?.errorCode).toBe("model_not_configured");
    expect(
      harness.events().find((event) => event.headSha === commitA),
    ).toBeDefined();
  });
});
