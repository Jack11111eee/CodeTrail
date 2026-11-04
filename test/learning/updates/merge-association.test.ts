import { afterEach, describe, expect, it } from "vitest";

import {
  changeEventIdFromKey,
  computeEventKey,
  type GenerationId,
  type SourceId,
} from "../../../src/learning/contracts/index.ts";
import {
  createLinkageService,
  decideLinkage,
} from "../../../src/learning/updates/linkage.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-12: after a merge the default-branch generation and its source record
 * exist before the PR lesson is linked; different content hashes produce a
 * supplementary lesson instead of reuse.
 */
describe("merge association", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  function seedEvent(
    head: string,
    base: string,
    kind: "pull_request" | "merge_commit",
  ) {
    const eventKey = computeEventKey({
      repoId: harness!.repo.repoId,
      streamId: kind === "pull_request" ? "pull_request:1" : "default_branch",
      kind,
      baseSha: base,
      headSha: head,
      mergeBaseSha: base,
      baseContextSha: base,
    });
    return changeEventIdFromKey(eventKey);
  }

  it("writes the link only after the default-branch record exists", async () => {
    harness = await createUpdateHarness();
    const base = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");
    harness.git.merge("feature", "merge: feature");
    const merge = harness.git.head("main");

    // Create the default-branch event first, like discovery does.
    const defaultEventId = seedEvent(merge, base, "merge_commit");
    const prEventId = seedEvent(head, base, "pull_request");
    harness.repos.changes.insertMany([
      {
        eventId: defaultEventId,
        eventKey: `default:${merge}`,
        repoId: harness.repo.repoId,
        projectId: harness.project.projectId,
        streamId: "default_branch",
        streamKind: "default_branch",
        kind: "merge_commit",
        baseSha: base,
        headSha: merge,
        mergeBaseSha: base,
        baseContextSha: base,
        significance: "full",
        state: "published",
        jobId: null,
        gapReason: null,
        linkedEventId: null,
        linkRelation: null,
        discoveredAt: harness.clock.now().toISOString(),
        publishedAt: harness.clock.now().toISOString(),
        payload: {},
      },
      {
        eventId: prEventId,
        eventKey: `pr:${head}`,
        repoId: harness.repo.repoId,
        projectId: harness.project.projectId,
        streamId: "pull_request:1",
        streamKind: "pull_request",
        kind: "pull_request",
        baseSha: base,
        headSha: head,
        mergeBaseSha: base,
        baseContextSha: base,
        significance: "full",
        state: "published",
        jobId: null,
        gapReason: null,
        linkedEventId: null,
        linkRelation: null,
        discoveredAt: harness.clock.now().toISOString(),
        publishedAt: harness.clock.now().toISOString(),
        payload: {},
      },
    ]);

    const generationId = "g_merge0000000000" as GenerationId;
    harness.repos.generations.insertPublished({
      generationId,
      cacheKey: "ck-merge",
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      commitSha: merge,
      comparisonBaseSha: null,
      kind: "change",
      scopeHash: harness.project.scope.hash,
      configHash: "cfg",
      promptTemplateVersion: "v1",
      preferencesVersion: 1,
      upstreamVersion: "u1",
      status: "published",
      contentDir: "/tmp/merge",
      sealedTreeHash: "tree",
      baselineFromGenerationId: null,
      fallbackReason: null,
      jobId: null,
      createdAt: harness.clock.now().toISOString(),
      publishedAt: harness.clock.now().toISOString(),
    });
    harness.repos.sources.insertMany([
      {
        generationId,
        sourceId: "s_merge0000000000" as SourceId,
        kind: "repo",
        commitSha: merge,
        payloadJson: "{}",
        contentHash: "hash",
      },
    ]);

    const decision = decideLinkage({
      prHeadTreeHash: harness.git.tree(head),
      mainTreeHash: harness.git.tree(head),
      prMergeBaseSha: base,
      mainMergeBaseSha: base,
      scopeHash: harness.project.scope.hash,
      configHash: "cfg",
    });
    expect(decision.relation).toBe("identical_content");

    await createLinkageService({ repos: harness.repos }).link({
      prEventId,
      defaultBranchEventId: defaultEventId,
      decision,
    });

    const pr = harness.repos.changes.byId(prEventId);
    expect(pr?.linkedEventId).toBe(defaultEventId);
    expect(pr?.linkRelation).toBe("identical_content");
    expect(harness.repos.generations.byId(generationId)).not.toBeNull();
    expect(harness.repos.sources.all(generationId)).toHaveLength(1);
  });

  it("keeps both records when the trees differ", () => {
    const decision = decideLinkage({
      prHeadTreeHash: "tree-pr",
      mainTreeHash: "tree-main",
      prMergeBaseSha: "base",
      mainMergeBaseSha: "base",
      scopeHash: "scope",
      configHash: "cfg",
    });
    expect(decision.relation).toBe("supplementary");
    expect(decision.reason).toBe("tree_differs");
    expect(decision.prFingerprint).not.toBe(decision.mainFingerprint);
  });
});
