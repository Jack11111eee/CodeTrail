import { describe, expect, it } from "vitest";

import type {
  Binding,
  GenerationId,
  PublishedWikiRef,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { validateEvidence } from "../../../src/learning/lessons/validate/evidence.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  createRetriever,
  type RetrievalContext,
} from "../../../src/learning/retrieval/search.ts";
import { createSourceSearcher } from "../../../src/learning/retrieval/source-search.ts";
import {
  fakeRegistry,
  fakeSnapshot,
  makeContext,
} from "../helpers/lesson-context.ts";
import {
  defaultGeneration,
  emptyCoverage,
  researchLesson,
} from "../helpers/lesson-sample.ts";

/**
 * Integration: strict version isolation (issue-18, AC-RET-05) and the lesson
 * evidence gate (issue-17) must agree on what "this generation" means.
 *
 * Retrieval refuses a context whose snapshot or wiki belongs to another
 * generation; the evidence validator refuses a ref whose commit is not in
 * `allowedCommitShas`. If only one layer enforced the rule, a lesson could cite
 * bytes from a neighbouring generation through a cached or misresolved hit.
 */

const PLACEHOLDER_SOURCE_ID = "s_0123456789abcdef";

const G1_ID = "g_1111111111111111" as GenerationId;
const G2_ID = "g_2222222222222222" as GenerationId;
const G1_SHA = "1".repeat(40);
const G2_SHA = "2".repeat(40);
const PATH = "src/app.py";

function statelessUpstream() {
  return {
    search: () => Promise.resolve([]),
    readSections: () => Promise.resolve([]),
    pageTitle: () => Promise.resolve(""),
  };
}

function remapSourceId(payload: unknown, replacement: string): unknown {
  return JSON.parse(
    JSON.stringify(payload).replaceAll(PLACEHOLDER_SOURCE_ID, replacement),
  ) as unknown;
}

describe("retrieval and the lesson gate share one isolation boundary", () => {
  it("keeps two generations apart and rejects a cross-generation citation", async () => {
    const g1 = defaultGeneration({ generationId: G1_ID, commitSha: G1_SHA });
    const g2 = defaultGeneration({ generationId: G2_ID, commitSha: G2_SHA });
    const g1Snapshot = fakeSnapshot(
      { [PATH]: "RETRY = 1\n" },
      { commitSha: G1_SHA, repoId: g1.repoId },
    );
    const g2Snapshot = fakeSnapshot(
      { [PATH]: "RETRY = 9\n" },
      { commitSha: G2_SHA, repoId: g2.repoId },
    );

    const binding1: Binding = {
      generationId: G1_ID,
      repoId: g1.repoId,
      commitSha: G1_SHA,
    };
    const binding2: Binding = {
      generationId: G2_ID,
      repoId: g2.repoId,
      commitSha: G2_SHA,
    };

    const contextByGeneration = new Map<string, RetrievalContext>([
      [G1_ID, { wiki: null, snapshot: g1Snapshot, scope: normalizeScope() }],
      [G2_ID, { wiki: null, snapshot: g2Snapshot, scope: normalizeScope() }],
    ]);

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: (binding) => {
        const context = contextByGeneration.get(binding.generationId);
        if (context === undefined) {
          throw new Error(`no context for ${binding.generationId}`);
        }
        return context;
      },
    });

    const g1Hits = await retriever.search(binding1, "RETRY");
    const g2Hits = await retriever.search(binding2, "RETRY");
    expect(g1Hits[0].preview).toContain("1");
    expect(g2Hits[0].preview).toContain("9");
    expect(g1Hits[0].binding).toEqual(binding1);
    expect(g2Hits[0].binding).toEqual(binding2);

    // The per-generation cache must not hand generation 1's entry to 2.
    const g1Again = await retriever.search(binding1, "RETRY");
    expect(g1Again[0].preview).toContain("1");
    expect(g1Again[0].preview).not.toContain("9");

    const registry = fakeRegistry();
    const g1Ref = await registry.registerRepo({
      generationId: G1_ID,
      repoId: g1.repoId,
      commitSha: G1_SHA,
      path: PATH,
      lines: { start: 1, end: 1 },
      snapshot: g1Snapshot,
      scope: normalizeScope(),
    });
    expect(g1Ref.sourceId).toBe(repoSourceId(PATH, G1_SHA, { start: 1, end: 1 }));
    expect(g1Ref.sourceId).not.toBe(repoSourceId(PATH, G2_SHA, null));

    const payload = remapSourceId(researchLesson(), g1Ref.sourceId);
    const parsed = parseLesson(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const g2Ctx = makeContext({
      mode: "research",
      generation: g2,
      registry,
      snapshot: g2Snapshot,
      coverage: emptyCoverage([PATH]),
      allowedCommitShas: [G2_SHA],
    });

    // Layer 1: the id is not in generation 2's staging bucket at all.
    const unknownToG2 = await validateEvidence(parsed.lesson, g2Ctx);
    expect(unknownToG2.ok).toBe(false);
    expect(
      unknownToG2.issues.some((issue) =>
        issue.message.includes("not registered to this generation"),
      ),
      "a g1 source id is unknown to the g2 registry bucket",
    ).toBe(true);

    // Layer 2: even if the id is smuggled into the g2 bucket, its commit is
    // outside `allowedCommitShas`, so the gate still refuses it.
    registry.add(G2_ID, g1Ref);
    const wrongCommit = await validateEvidence(parsed.lesson, g2Ctx);
    expect(wrongCommit.ok).toBe(false);
    expect(
      wrongCommit.issues.some((issue) =>
        issue.message.includes("does not belong to this generation"),
      ),
      "a g1 commit may not back a g2 lesson",
    ).toBe(true);

    // The owning generation accepts the very same citation.
    const g1Ctx = makeContext({
      mode: "research",
      generation: g1,
      registry,
      snapshot: g1Snapshot,
      coverage: emptyCoverage([PATH]),
      allowedCommitShas: [G1_SHA],
    });
    const accepted = await validateEvidence(parsed.lesson, g1Ctx);
    expect(accepted.issues).toEqual([]);
    expect(accepted.ok).toBe(true);
  });

  it("refuses a wiki or a snapshot bound to another generation before searching", async () => {
    const g1 = defaultGeneration({ generationId: G1_ID, commitSha: G1_SHA });
    const g2 = defaultGeneration({ generationId: G2_ID, commitSha: G2_SHA });
    const g1Snapshot = fakeSnapshot(
      { [PATH]: "RETRY = 1\n" },
      { commitSha: G1_SHA, repoId: g1.repoId },
    );
    const g2Snapshot = fakeSnapshot(
      { [PATH]: "RETRY = 9\n" },
      { commitSha: G2_SHA, repoId: g2.repoId },
    );
    const binding1: Binding = {
      generationId: G1_ID,
      repoId: g1.repoId,
      commitSha: G1_SHA,
    };

    const foreignWiki: PublishedWikiRef = {
      state: "published",
      generationId: G2_ID,
      commitSha: G2_SHA,
      knowledgeDir: "/tmp/foreign-generation",
      sealedTreeHash: "tree-foreign",
    };

    const searchSpy: string[] = [];
    const retriever = createRetriever({
      upstream: {
        search: () => {
          searchSpy.push("wiki");
          return Promise.resolve([]);
        },
        readSections: () => Promise.resolve([]),
        pageTitle: () => Promise.resolve(""),
      },
      source: createSourceSearcher(),
      resolve: () => ({
        wiki: foreignWiki,
        snapshot: g1Snapshot,
        scope: normalizeScope(),
      }),
    });

    await expect(retriever.search(binding1, "RETRY")).rejects.toMatchObject({
      code: "version_mismatch",
    });
    expect(searchSpy, "a foreign wiki must be refused before it is searched").toEqual(
      [],
    );

    const wrongSnapshotRetriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => ({
        wiki: null,
        snapshot: g2Snapshot,
        scope: normalizeScope(),
      }),
    });
    await expect(
      wrongSnapshotRetriever.search(binding1, "RETRY"),
    ).rejects.toMatchObject({ code: "version_mismatch" });

    // Sanity: the same binding against its own generation is accepted.
    const ownRetriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => ({
        wiki: null,
        snapshot: g1Snapshot,
        scope: normalizeScope(),
      }),
    });
    const hits = await ownRetriever.search(binding1, "RETRY");
    expect(hits[0].binding).toEqual(binding1);
    // Both generations exist and have distinct commits; only g1 is searched here.
    expect(g2.commitSha).not.toBe(g1.commitSha);
  });
});
