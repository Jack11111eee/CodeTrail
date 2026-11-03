import { afterEach, describe, expect, it } from "vitest";

import {
  changeEventIdFromKey,
  computeEventKey,
  emptyCursor,
} from "../../../src/learning/contracts/index.ts";
import { commitDiscovery } from "../../../src/learning/updates/discovery.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-17: events, pending jobs and the discovery cursor are written in one
 * transaction. A rejected cursor compare-and-swap rolls all of them back, and
 * model analysis happens only after the commit.
 */
describe("discovery transaction", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("rolls back events and jobs when the cursor CAS fails", async () => {
    harness = await createUpdateHarness();
    const head = harness.git.head("main");
    const eventKey = computeEventKey({
      repoId: harness.repo.repoId,
      streamId: "default_branch",
      kind: "commit",
      baseSha: null,
      headSha: head,
      mergeBaseSha: null,
      baseContextSha: null,
    });
    const event = {
      eventId: changeEventIdFromKey(eventKey),
      eventKey,
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      streamId: "default_branch",
      streamKind: "default_branch" as const,
      kind: "commit" as const,
      baseSha: null,
      headSha: head,
      mergeBaseSha: null,
      baseContextSha: null,
      significance: "full" as const,
      state: "queued" as const,
      jobId: null,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: harness.clock.now().toISOString(),
      publishedAt: null,
      payload: {},
    };
    const job = {
      kind: "change_analysis" as const,
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      streamId: "default_branch",
      comparisonBaseSha: null,
      headSha: head,
      baseContextSha: null,
      scopeHash: harness.project.scope.hash,
      analysisConfigHash: "cfg",
      payload: {
        kind: "change" as const,
        eventId: event.eventId,
        baseSha: head,
        headSha: head,
        mergeBaseSha: head,
        streamKind: "default_branch" as const,
      },
    };

    await expect(
      commitDiscovery(
        { db: harness.db, repos: harness.repos, clock: harness.clock },
        {
          events: [event],
          jobs: [job],
          discoveryCursor: {
            repoId: harness.repo.repoId,
            streamId: "default_branch",
            kind: "discovery",
            cursor: { ...emptyCursor("default_branch"), headSha: head },
            expectedPrevious: { headSha: "f".repeat(40), updatedAt: null },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    // All-or-nothing: neither the event nor its job survived.
    expect(harness.events()).toHaveLength(0);
    expect(harness.jobs()).toHaveLength(0);
    expect(harness.discoveryCursor()).toBeNull();
    // Still nothing has been published or analysed.
    expect(
      harness.repos.generations.listByProject(harness.project.projectId),
    ).toHaveLength(0);
  });

  it("commits events, jobs and the cursor together", async () => {
    harness = await createUpdateHarness();
    const head = harness.git.head("main");
    const eventKey = computeEventKey({
      repoId: harness.repo.repoId,
      streamId: "default_branch",
      kind: "commit",
      baseSha: null,
      headSha: head,
      mergeBaseSha: null,
      baseContextSha: null,
    });
    const eventId = changeEventIdFromKey(eventKey);
    await commitDiscovery(
      { db: harness.db, repos: harness.repos, clock: harness.clock },
      {
        events: [
          {
            eventId,
            eventKey,
            repoId: harness.repo.repoId,
            projectId: harness.project.projectId,
            streamId: "default_branch",
            streamKind: "default_branch",
            kind: "commit",
            baseSha: null,
            headSha: head,
            mergeBaseSha: null,
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
        ],
        jobs: [
          {
            kind: "change_analysis",
            repoId: harness.repo.repoId,
            projectId: harness.project.projectId,
            streamId: "default_branch",
            comparisonBaseSha: null,
            headSha: head,
            baseContextSha: null,
            scopeHash: harness.project.scope.hash,
            analysisConfigHash: "cfg",
            payload: {
              kind: "change",
              eventId,
              baseSha: head,
              headSha: head,
              mergeBaseSha: head,
              streamKind: "default_branch",
            },
          },
        ],
        discoveryCursor: {
          repoId: harness.repo.repoId,
          streamId: "default_branch",
          kind: "discovery",
          cursor: { ...emptyCursor("default_branch"), headSha: head },
          expectedPrevious: null,
        },
      },
    );
    expect(harness.events()).toHaveLength(1);
    expect(harness.jobs()).toHaveLength(1);
    expect(harness.discoveryCursor()?.headSha).toBe(head);
  });
});
