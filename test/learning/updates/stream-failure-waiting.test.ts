import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-16: after a failure the event is kept, the published cursor does not
 * advance and later events in that stream are `waiting`; other streams
 * continue.
 */
describe("stream failure waiting", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("keeps the failed event and parks successors without advancing published", async () => {
    harness = await createUpdateHarness();
    await harness.tick();

    harness.git.write("src/one.ts", "export const one = 1;\n");
    const firstSha = harness.git.commit("feat: one");
    await harness.tick();

    const firstJob = harness
      .jobs()
      .find(
        (job) =>
          job.streamId === "default_branch" &&
          job.payload.kind === "change" &&
          job.payload.headSha === firstSha,
      );
    expect(firstJob).toBeDefined();
    harness.repos.jobs.transition(firstJob!.jobId, ["queued"], "running", {
      startedAt: harness.clock.now().toISOString(),
      attempt: 1,
    });
    harness.repos.jobs.transition(firstJob!.jobId, ["running"], "failed", {
      finishedAt: harness.clock.now().toISOString(),
      errorCode: "internal_error",
    });

    // A later event in the same stream, plus a different stream.
    harness.git.write("src/two.ts", "export const two = 2;\n");
    const secondSha = harness.git.commit("feat: two");

    const baseHead = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");
    harness.github.setPulls([
      makePull({
        number: 2,
        headSha: head,
        baseHeadSha: baseHead,
        updatedAt: "2024-06-01T00:59:30.000Z",
      }),
    ]);

    await harness.tick();

    const byHead = (sha: string) =>
      harness!.events().find((event) => event.headSha === sha);
    expect(byHead(firstSha)?.state).toBe("failed");
    expect(byHead(secondSha)?.state).toBe("waiting");
    expect(byHead(secondSha)?.jobId).toBeNull();

    // The published cursor never advances on failure.
    expect(
      harness.repos.cursors.get(
        harness.repo.repoId,
        "default_branch",
        "published",
      ),
    ).toBeNull();

    // Another stream keeps moving.
    const pr = harness.events().find((event) => event.kind === "pull_request");
    expect(pr?.state).toBe("queued");
  });
});
