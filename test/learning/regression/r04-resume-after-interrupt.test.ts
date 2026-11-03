/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * AC-R04-02: an interrupted tick must be resumable from the persisted cursor.
 * The default-branch half commits (events + jobs + cursor) before the PR half
 * throws, so the next process starts from the advanced cursor: no unpublished
 * event is lost, no published event is re-created, and `changes.event_key`
 * still guarantees one event can never yield a second published generation.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  emptyCursor,
  type GithubClient,
} from "../../../src/learning/contracts/index.ts";
import { createDiscoveryService } from "../../../src/learning/updates/discovery.ts";
import { runWatchTick } from "../../../src/learning/updates/watch.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "../updates/harness.ts";

let harness: UpdateHarness | undefined;

afterEach(() => {
  cleanupHarness(harness);
  harness = undefined;
});

function countForHead(harness: UpdateHarness, sha: string): number {
  return harness.events().filter((event) => event.headSha === sha).length;
}

describe("AC-R04-02 — resume after an interruption", () => {
  it("resumes from the cursor without losing or duplicating work", async () => {
    harness = await createUpdateHarness();
    await harness.tick();

    // Two commits land, and a PR is in the window. The interrupted tick below
    // commits the default-branch half and then dies in the PR half.
    harness.git.write("src/b.ts", "export const b = 1;\n");
    const commitB = harness.git.commit("feat: b");
    harness.git.write("src/c.ts", "export const c = 1;\n");
    const commitC = harness.git.commit("feat: c");

    const base = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const prHead = harness.git.commit("feat: feature");
    harness.git.checkout("main");
    harness.github.setPulls([
      makePull({
        number: 4,
        headSha: prHead,
        baseHeadSha: base,
        updatedAt: "2024-06-01T00:59:00.000Z",
      }),
    ]);

    const interruptedGithub: GithubClient = {
      ...harness.github,
      pullRequests: async () => {
        throw new Error("interrupted before the PR half");
      },
    };
    const interruptedDiscovery = createDiscoveryService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
      github: interruptedGithub,
      paths: harness.paths,
    });

    await expect(
      runWatchTick(
        {
          ...harness.deps,
          github: interruptedGithub,
          discovery: interruptedDiscovery,
        },
        harness.project.projectId,
      ),
    ).rejects.toThrow("interrupted before the PR half");

    // The default-branch half is fully durable: two commit events, two jobs,
    // and the discovery cursor already at the landed head.
    expect(countForHead(harness, commitB)).toBe(1);
    expect(countForHead(harness, commitC)).toBe(1);
    expect(harness.jobs()).toHaveLength(2);
    expect(harness.discoveryCursor()?.headSha).toBe(commitC);
    // Nothing is published yet, and the published cursor lags discovery.
    expect(
      harness.repos.cursors.get(
        harness.repo.repoId,
        "default_branch",
        "published",
      ),
    ).toBeNull();

    const eventIdsBefore = harness
      .events()
      .map((event) => event.eventId)
      .sort();

    // Restart: a fresh discovery service over the same database. The advanced
    // default-branch cursor means those commits are not rediscovered; only the
    // PR half that the interrupt never committed is picked up, exactly once.
    const restarted = createDiscoveryService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
      github: harness.github,
      paths: harness.paths,
    });
    const resumed = await runWatchTick(
      { ...harness.deps, discovery: restarted },
      harness.project.projectId,
    );
    expect(resumed.discovered).toBe(1);
    expect(countForHead(harness, commitB)).toBe(1);
    expect(countForHead(harness, commitC)).toBe(1);
    const prEventsAfterResume = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(prEventsAfterResume).toHaveLength(1);
    for (const eventId of eventIdsBefore) {
      expect(
        harness.events().filter((event) => event.eventId === eventId),
      ).toHaveLength(1);
    }

    // A further tick re-reads the overlap window but cannot insert anything:
    // the event keys are already persisted. Moving one full overlap past the
    // watermark then makes discovery empty.
    harness.clock.advance(10 * 60_000);
    const settledIds = harness
      .events()
      .map((event) => event.eventId)
      .sort();
    const settledJobs = harness
      .jobs()
      .map((job) => job.jobId)
      .sort();
    const replayed = await runWatchTick(
      { ...harness.deps, discovery: restarted },
      harness.project.projectId,
    );
    expect(replayed.enqueued).toBe(0);
    expect(
      harness
        .events()
        .map((event) => event.eventId)
        .sort(),
    ).toEqual(settledIds);
    expect(
      harness
        .jobs()
        .map((job) => job.jobId)
        .sort(),
    ).toEqual(settledJobs);

    harness.clock.advance(2 * 60_000);
    const settled = await runWatchTick(
      { ...harness.deps, discovery: restarted },
      harness.project.projectId,
    );
    expect(settled.discovered).toBe(0);
    expect(
      harness
        .events()
        .map((event) => event.eventId)
        .sort(),
    ).toEqual(settledIds);
    expect(
      harness
        .jobs()
        .map((job) => job.jobId)
        .sort(),
    ).toEqual(settledJobs);

    // A completed publish for B is persisted once; a further tick must not
    // re-queue it or fabricate a second generation for the same event.
    const eventB = harness.events().find((event) => event.headSha === commitB);
    expect(eventB).toBeDefined();
    const jobB = harness.jobs().find((job) => job.jobId === eventB!.jobId);
    expect(jobB).toBeDefined();
    harness.repos.changes.setState(eventB!.eventId, "published", {
      publishedAt: harness.clock.now().toISOString(),
    });
    harness.repos.cursors.put({
      repoId: harness.repo.repoId,
      streamId: "default_branch",
      kind: "published",
      cursor: { ...emptyCursor("default_branch"), headSha: commitB },
      expectedPrevious: null,
    });

    const afterPublish = await runWatchTick(
      { ...harness.deps, discovery: restarted },
      harness.project.projectId,
    );
    expect(afterPublish.discovered).toBe(0);
    expect(countForHead(harness, commitB)).toBe(1);
    expect(
      harness.jobs().filter((job) => job.jobId === jobB!.jobId),
    ).toHaveLength(1);
    expect(
      harness.events().find((event) => event.eventId === eventB!.eventId)
        ?.state,
    ).toBe("published");
    // C is still present and unpublished: catch-up lost nothing.
    expect(
      harness.events().find((event) => event.headSha === commitC)?.state,
    ).toBe("queued");
    expect(
      harness.repos.generations.listByProject(harness.project.projectId),
    ).toHaveLength(0);
  });
});
