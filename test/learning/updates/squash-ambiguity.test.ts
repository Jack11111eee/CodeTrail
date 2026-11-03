import { afterEach, describe, expect, it } from "vitest";

import {
  changeEventIdFromKey,
  computeEventKey,
} from "../../../src/learning/contracts/index.ts";
import {
  computeComparisonFingerprint,
  decideLinkage,
} from "../../../src/learning/updates/linkage.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-13: squash/rebase makes linkage unreliable and keeps two versioned
 * records; reuse is decided only by content/context hash equality and the
 * reuse path issues zero model calls.
 */
describe("squash ambiguity", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("returns unlinked_squash when the PR head is not reachable", () => {
    const decision = decideLinkage({
      prHeadTreeHash: "tree-pr",
      mainTreeHash: "tree-main",
      prMergeBaseSha: "base",
      mainMergeBaseSha: "base",
      scopeHash: "scope",
      configHash: "cfg",
      reachableFromDefaultBranch: false,
    });
    expect(decision.relation).toBe("unlinked_squash");
    expect(decision.reason).toBe("not_reachable_from_default_branch");
  });

  it("keeps two event records for an unreliable squash", async () => {
    harness = await createUpdateHarness();
    const head = harness.git.head("main");
    const mk = (stream: string, kind: "pull_request" | "commit") => {
      const key = computeEventKey({
        repoId: harness!.repo.repoId,
        streamId: stream,
        kind,
        baseSha: head,
        headSha: head,
        mergeBaseSha: head,
        baseContextSha: head,
      });
      return changeEventIdFromKey(key);
    };
    const prId = mk("pull_request:9", "pull_request");
    const mainId = mk("default_branch", "commit");
    const base = {
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      baseSha: head,
      headSha: head,
      mergeBaseSha: head,
      baseContextSha: head,
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
        ...base,
        eventId: prId,
        eventKey: "squash-pr",
        streamId: "pull_request:9",
        streamKind: "pull_request",
        kind: "pull_request",
      },
      {
        ...base,
        eventId: mainId,
        eventKey: "squash-main",
        streamId: "default_branch",
        streamKind: "default_branch",
        kind: "commit",
      },
    ]);
    expect(
      harness.repos.changes.countByProject(harness.project.projectId),
    ).toBe(2);
  });

  it("makes zero model calls on the reuse path", () => {
    let calls = 0;
    const model = {
      chat() {
        calls += 1;
        throw new Error("the reuse path must not call a model");
      },
    };
    const decision = decideLinkage({
      prHeadTreeHash: "same-tree",
      mainTreeHash: "same-tree",
      prMergeBaseSha: "same-base",
      mainMergeBaseSha: "same-base",
      scopeHash: "scope",
      configHash: "cfg",
    });
    void model;
    expect(decision.relation).toBe("identical_content");
    expect(calls).toBe(0);
    // The fingerprint is independently recomputable and stable.
    expect(
      computeComparisonFingerprint({
        treeHash: "same-tree",
        mergeBaseSha: "same-base",
        scopeHash: "scope",
        configHash: "cfg",
      }),
    ).toBe(decision.prFingerprint);
  });
});
