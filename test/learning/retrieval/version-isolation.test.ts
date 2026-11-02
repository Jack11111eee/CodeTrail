import { describe, expect, it } from "vitest";

import type {
  GenerationId,
  RegisterRepoSourceInput,
  RepoId,
} from "../../../src/learning/contracts/index.js";
import {
  allowedCommitShas,
  multiView,
} from "../../../src/learning/evidence/multi-view.js";
import {
  createSourceRegistry,
  sourceRowFromRef,
} from "../../../src/learning/evidence/registry.js";
import {
  createRepositories,
  openDatabase,
} from "../../../src/learning/store/index.js";
import {
  BASE_SHA,
  DEFAULT_SCOPE,
  HEAD_SHA,
  createEvidenceHarness,
  fakeSnapshot,
  fixedClock,
  makeGeneration,
  type EvidenceHarness,
} from "./evidence-harness.js";

function repoInput(
  harness: EvidenceHarness,
  generationId: GenerationId,
  commitSha: string,
  path: string,
  text: string,
): RegisterRepoSourceInput {
  return {
    generationId,
    repoId: "r_1" as RepoId,
    commitSha,
    path,
    lines: null,
    snapshot: fakeSnapshot({ [path]: text }, { commitSha }),
    scope: DEFAULT_SCOPE,
  };
}

describe("multi-generation source isolation", () => {
  it("rejects a foreign generation's source id with version_mismatch", async () => {
    const harness = await createEvidenceHarness();
    const g1 = "g_1" as GenerationId;
    const g2 = "g_2" as GenerationId;
    try {
      const first = await harness.registry.registerRepo(
        repoInput(harness, g1, HEAD_SHA, "src/index.ts", "head side\n"),
      );
      const second = await harness.registry.registerRepo(
        repoInput(
          harness,
          g2,
          "c".repeat(40),
          "src/index.ts",
          "other version\n",
        ),
      );
      expect(first.sourceId).not.toBe(second.sourceId);

      const view = multiView(harness.registry, [g1]);
      expect(view.get(first.sourceId)).toEqual(first);
      expect(view.get(second.sourceId)).toBeNull();
      expect(view.ownerOf(first.sourceId)).toBe(g1);
      expect(view.ownerOf(second.sourceId)).toBeNull();
      expect(() => view.assertBelongsTo(second.sourceId)).toThrowError(
        expect.objectContaining({ code: "version_mismatch" }),
      );
      expect(view.all()).toEqual([first]);
      expect(view.allowedCommitShas()).toEqual([HEAD_SHA]);
    } finally {
      harness.close();
    }
  });

  it("accepts only a comparison generation's head and base commits", async () => {
    const harness = await createEvidenceHarness();
    const generationId = "g_compare" as GenerationId;
    const intruderSha = "e".repeat(40);
    try {
      const record = makeGeneration({
        generationId,
        kind: "comparison",
        commitSha: HEAD_SHA,
        comparisonBaseSha: BASE_SHA,
      });
      harness.repos.generations.insertPublished(record);
      harness.registry.bindGeneration(generationId);

      const base = await harness.registry.registerRepo(
        repoInput(harness, generationId, BASE_SHA, "src/index.ts", "before\n"),
      );
      const head = await harness.registry.registerRepo(
        repoInput(harness, generationId, HEAD_SHA, "src/index.ts", "after\n"),
      );
      const intruder = await harness.registry.registerRepo(
        repoInput(
          harness,
          generationId,
          intruderSha,
          "src/other.ts",
          "not part of either side\n",
        ),
      );

      const view = multiView(harness.registry, [generationId]);
      expect([...view.allowedCommitShas()].sort()).toEqual(
        [HEAD_SHA, BASE_SHA].sort(),
      );
      expect(view.assertBelongsTo(base.sourceId)).toEqual(base);
      expect(view.assertBelongsTo(head.sourceId)).toEqual(head);
      expect(() => view.assertBelongsTo(intruder.sourceId)).toThrowError(
        expect.objectContaining({ code: "version_mismatch" }),
      );

      expect([...allowedCommitShas(record)].sort()).toEqual(
        [HEAD_SHA, BASE_SHA].sort(),
      );
    } finally {
      harness.close();
    }
  });

  it("survives restart: persisted rows still reject a foreign id", async () => {
    const harness = await createEvidenceHarness();
    const g1 = "g_1" as GenerationId;
    const g2 = "g_2" as GenerationId;
    let reopened: ReturnType<typeof openDatabase> | null = null;
    try {
      const first = await harness.registry.registerRepo(
        repoInput(harness, g1, HEAD_SHA, "src/index.ts", "head\n"),
      );
      const second = await harness.registry.registerRepo(
        repoInput(harness, g2, "d".repeat(40), "src/index.ts", "foreign\n"),
      );

      harness.db.transaction(() => {
        harness.repos.generations.insertPublished(
          makeGeneration({ generationId: g1 }),
        );
        harness.repos.generations.insertPublished(
          makeGeneration({
            generationId: g2,
            commitSha: "d".repeat(40),
          }),
        );
        harness.repos.sources.insertMany([
          sourceRowFromRef(first),
          sourceRowFromRef(second),
        ]);
      });

      harness.db.close();
      reopened = openDatabase({ file: harness.paths.db, clock: fixedClock() });
      const repos = createRepositories(reopened);
      const registry = createSourceRegistry({
        clock: fixedClock(),
        sources: repos.sources,
        generations: repos.generations,
      });

      const view = multiView(registry, [g1]);
      expect(view.assertBelongsTo(first.sourceId)).toEqual(first);
      expect(() => view.assertBelongsTo(second.sourceId)).toThrowError(
        expect.objectContaining({ code: "version_mismatch" }),
      );
    } finally {
      reopened?.close();
      try {
        harness.close();
      } catch {
        // already closed above
      }
    }
  });

  it("shares an id across generations only when they share a commit", async () => {
    const harness = await createEvidenceHarness();
    const g1 = "g_1" as GenerationId;
    const g2 = "g_2" as GenerationId;
    try {
      const first = await harness.registry.registerRepo(
        repoInput(harness, g1, HEAD_SHA, "src/index.ts", "same\n"),
      );
      const shared = await harness.registry.registerRepo(
        repoInput(harness, g2, HEAD_SHA, "src/index.ts", "same\n"),
      );
      expect(shared.sourceId).toBe(first.sourceId);

      const view = multiView(harness.registry, [g1, g2]);
      expect(view.ownerOf(first.sourceId)).toBe(g1);
      expect(view.assertBelongsTo(first.sourceId)).toEqual(first);
      expect(view.all()).toHaveLength(1);
    } finally {
      harness.close();
    }
  });
});
