/**
 * AC-R04-01: the same delivery never becomes two inbox rows. A PR that GitHub
 * delivers twice (inside one page, and again on the next tick) still yields one
 * `change_events` row and one job, and a squash merge whose tree differs keeps
 * both versioned records instead of collapsing them into a false reuse.
 *
 * The discovery path is the production one (`runWatchTick` -> transactional
 * discovery), so this fails if deduplication is ever moved after the insert or
 * the overlap window stops being idempotent.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  changeEventIdFromKey,
  computeEventKey,
} from "../../../src/learning/contracts/index.ts";
import {
  createLinkageService,
  decideLinkage,
} from "../../../src/learning/updates/linkage.ts";
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

describe("AC-R04-01 — duplicate delivery and squash ambiguity", () => {
  it("yields one event and one job for a duplicate PR delivery", async () => {
    harness = await createUpdateHarness();
    const base = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");

    // The exact same pull request twice in one page: an at-least-once
    // delivery from the server must not double-insert.
    const delivered = makePull({
      number: 7,
      headSha: head,
      baseHeadSha: base,
      updatedAt: "2024-06-01T00:59:00.000Z",
    });
    harness.github.setPulls([delivered, { ...delivered }]);
    await harness.tick();

    const prEvents = () =>
      harness!.events().filter((event) => event.kind === "pull_request");
    const prJobs = () =>
      harness!.jobs().filter((job) => job.streamId === "pull_request:7");

    expect(prEvents()).toHaveLength(1);
    expect(prJobs()).toHaveLength(1);
    const stableJobId = prJobs()[0]?.jobId;
    const stableEventId = prEvents()[0]?.eventId;

    // The next tick re-enters the overlap window; the same event is updated in
    // place (metadata only) rather than reinserted with a new job.
    harness.clock.advance(30_000);
    await harness.tick();
    expect(prEvents()).toHaveLength(1);
    expect(prJobs()).toHaveLength(1);
    expect(prEvents()[0]?.eventId).toBe(stableEventId);
    expect(prJobs()[0]?.jobId).toBe(stableJobId);
    expect(
      harness.repos.changes.countByProject(harness.project.projectId),
    ).toBe(
      2, // one baseline + one PR
    );
  });

  it("keeps two records when a squash's tree differs", async () => {
    harness = await createUpdateHarness();
    const base = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");
    // The landed (squashed) commit has different content from the PR head.
    harness.git.write("src/landed.ts", "export const landed = 1;\n");
    const landed = harness.git.commit("squash: land feature differently");

    const prEventId = changeEventIdFromKey(
      computeEventKey({
        repoId: harness.repo.repoId,
        streamId: "pull_request:7",
        kind: "pull_request",
        baseSha: base,
        headSha: head,
        mergeBaseSha: base,
        baseContextSha: base,
      }),
    );
    const mainEventId = changeEventIdFromKey(
      computeEventKey({
        repoId: harness.repo.repoId,
        streamId: "default_branch",
        kind: "commit",
        baseSha: base,
        headSha: landed,
        mergeBaseSha: base,
        baseContextSha: base,
      }),
    );
    const common = {
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      baseSha: base,
      mergeBaseSha: base,
      baseContextSha: base,
      significance: "full" as const,
      state: "discovered" as const,
      jobId: null,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: harness.clock.now().toISOString(),
      publishedAt: null,
      payload: {},
    };
    harness.repos.changes.insertMany([
      {
        ...common,
        eventId: prEventId,
        eventKey: "r04-squash-pr",
        streamId: "pull_request:7",
        streamKind: "pull_request",
        kind: "pull_request",
        headSha: head,
      },
      {
        ...common,
        eventId: mainEventId,
        eventKey: "r04-squash-main",
        streamId: "default_branch",
        streamKind: "default_branch",
        kind: "commit",
        headSha: landed,
      },
    ]);

    const decision = decideLinkage({
      prHeadTreeHash: harness.git.tree(head),
      mainTreeHash: harness.git.tree(landed),
      prMergeBaseSha: base,
      mainMergeBaseSha: base,
      scopeHash: harness.project.scope.hash,
      configHash: "cfg",
      reachableFromDefaultBranch: false,
    });
    expect(decision.relation).toBe("unlinked_squash");
    expect(decision.reason).toBe("not_reachable_from_default_branch");
    expect(decision.prFingerprint).not.toBe(decision.mainFingerprint);

    await createLinkageService({ repos: harness.repos }).link({
      prEventId,
      defaultBranchEventId: mainEventId,
      decision,
    });

    // Both versioned records survive; the PR points at the landed commit with
    // an explicit "this was a squash, do not reuse" relation.
    expect(
      harness.repos.changes.countByProject(harness.project.projectId),
    ).toBe(2);
    const pr = harness.repos.changes.byId(prEventId);
    expect(pr?.headSha).toBe(head);
    expect(pr?.linkedEventId).toBe(mainEventId);
    expect(pr?.linkRelation).toBe("unlinked_squash");
    expect(harness.repos.changes.byId(mainEventId)?.headSha).toBe(landed);
  });
});
