import { describe, expect, it } from "vitest";

import { LearningError, sliceHash } from "../../../src/learning/contracts/index.ts";
import type {
  GenerationId,
  RepoId,
  SourceId,
} from "../../../src/learning/contracts/index.ts";
import { multiView } from "../../../src/learning/evidence/multi-view.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import type { AnyLesson } from "../../../src/learning/lessons/schema.ts";
import {
  OTHER_HEAD_SHA,
  comparisonLesson,
  researchLesson,
} from "../helpers/lesson-sample.ts";
import {
  BASE_SHA,
  DEFAULT_SCOPE,
  HEAD_SHA,
  createEvidenceHarness,
  fakeSnapshot,
  makeGeneration,
} from "../retrieval/evidence-harness.ts";

/**
 * Integration: lesson schema/publish gate (issue-15) + source registry and
 * multi-generation view (issue-14).
 *
 * Neither module can make these assertions alone. The schema accepts any
 * non-empty `sourceId` (it has no registry), while the registry knows nothing
 * about lessons. The product relies on the two composing: every id a lesson
 * cites must resolve through the registry, a comparison lesson's base/head ids
 * must resolve to *different* commits, and a foreign or unregistered id — which
 * still parses as a string — must be rejected by the version view.
 */

interface SampleIds {
  generationId: GenerationId;
  repoId: RepoId;
}

function sampleIds(): SampleIds {
  const draft = researchLesson();
  const context = draft.context as { repoId: RepoId };
  return {
    generationId: draft.generationId as GenerationId,
    repoId: context.repoId,
  };
}

function parsed(raw: unknown): AnyLesson {
  const result = parseLesson(raw);
  if (!result.ok) {
    throw new Error(`lesson did not parse: ${JSON.stringify(result.failures)}`);
  }
  return result.lesson;
}

/** Points every evidence-bearing group at `ids` so the round-trip is complete. */
function pointAt(lesson: AnyLesson, ids: SourceId[]): AnyLesson {
  lesson.evidence = [...ids];
  for (const statement of lesson.statements) statement.evidenceIds = [...ids];
  for (const boundary of lesson.boundaries) boundary.evidenceIds = [...ids];
  for (const choice of lesson.choices) {
    choice.evidenceIds = [...ids];
    for (const alternative of choice.alternatives) {
      alternative.evidenceIds = [...ids];
    }
  }
  for (const node of lesson.diagram.nodes) node.evidenceIds = [...ids];
  for (const edge of lesson.diagram.edges) edge.evidenceIds = [...ids];
  return lesson;
}

function evidenceIdsOf(lesson: AnyLesson): SourceId[] {
  const ids = new Set<SourceId>();
  const add = (list: readonly SourceId[]): void => {
    for (const id of list) ids.add(id);
  };
  add(lesson.evidence);
  for (const statement of lesson.statements) add(statement.evidenceIds);
  for (const boundary of lesson.boundaries) add(boundary.evidenceIds);
  for (const choice of lesson.choices) {
    add(choice.evidenceIds);
    for (const alternative of choice.alternatives) add(alternative.evidenceIds);
  }
  for (const node of lesson.diagram.nodes) add(node.evidenceIds);
  for (const edge of lesson.diagram.edges) add(edge.evidenceIds);
  return [...ids];
}

describe("lesson evidence → registry round-trip", () => {
  it("resolves every cited source id, including external and teaching-example refs", async () => {
    const harness = await createEvidenceHarness();
    const { generationId, repoId } = sampleIds();
    const sourceText = [
      "class SnapshotCache:",
      "    def evict(self, snapshot):",
      "        del self._cache[snapshot.id]",
      "",
    ].join("\n");

    try {
      const repoSrc = await harness.registry.registerRepo({
        generationId,
        repoId,
        commitSha: HEAD_SHA,
        path: "src/lmp/state/snapshot_cache.py",
        lines: { start: 1, end: 3 },
        snapshot: fakeSnapshot(
          { "src/lmp/state/snapshot_cache.py": sourceText },
          { commitSha: HEAD_SHA, repoId },
        ),
        scope: DEFAULT_SCOPE,
      });

      harness.registry.bindGeneration(generationId);
      const external = harness.registry.registerExternal({
        ok: true,
        canonicalUrl: "https://docs.python.org/3/library/asyncio.html",
        versionOrRetrievedAt: "3.12",
        locator: "Event loop",
        contentHash: sliceHash("event loop background"),
        title: "asyncio",
        text: "event loop background",
      });
      const teaching = harness.registry.registerTeachingExample({
        exampleId: "ex_request_loop",
        label: "示例：一次请求往返",
      });

      const lesson = pointAt(parsed(researchLesson()), [
        repoSrc.sourceId,
        external.sourceId,
        teaching.sourceId,
      ]);
      // The schema accepts the exact ids the registry minted.
      expect(() => parsed(lesson)).not.toThrow();

      const view = multiView(harness.registry, [generationId]);
      expect([...view.allowedCommitShas()]).toEqual([HEAD_SHA]);
      for (const id of evidenceIdsOf(lesson)) {
        expect(() => view.assertBelongsTo(id)).not.toThrow();
      }

      const resolvedRepo = view.assertBelongsTo(repoSrc.sourceId);
      expect(resolvedRepo).toEqual(repoSrc);
      if (resolvedRepo.kind !== "repo") throw new Error("expected repo ref");
      expect(resolvedRepo.contentHash).toBe(
        sliceHash(sourceText.split("\n").slice(0, 3).join("\n")),
      );

      const resolvedExternal = view.assertBelongsTo(external.sourceId);
      if (resolvedExternal.kind !== "external") {
        throw new Error("expected external ref");
      }
      expect(resolvedExternal.canonicalUrl).toBe(external.canonicalUrl);
      expect(resolvedExternal.versionOrRetrievedAt).toBe("3.12");
      expect(resolvedExternal.locator).toBe("Event loop");
      expect(resolvedExternal.contentHash).toBe(external.contentHash);
      expect(resolvedExternal).not.toHaveProperty("commitSha");
      expect(resolvedExternal).not.toHaveProperty("path");

      const resolvedTeaching = view.assertBelongsTo(teaching.sourceId);
      if (resolvedTeaching.kind !== "teaching_example") {
        throw new Error("expected teaching-example ref");
      }
      expect(resolvedTeaching.label).toBe("示例：一次请求往返");
      expect(resolvedTeaching).not.toHaveProperty("canonicalUrl");
      expect(resolvedTeaching).not.toHaveProperty("contentHash");
    } finally {
      harness.close();
    }
  });

  it("accepts an unregistered id in the schema but rejects it in the version view", async () => {
    const harness = await createEvidenceHarness();
    const { generationId, repoId } = sampleIds();
    const stray = "s_ffffffffffffffff" as SourceId;

    try {
      const repoSrc = await harness.registry.registerRepo({
        generationId,
        repoId,
        commitSha: HEAD_SHA,
        path: "src/index.ts",
        lines: null,
        snapshot: fakeSnapshot(
          { "src/index.ts": "export const v = 1;\n" },
          { commitSha: HEAD_SHA, repoId },
        ),
        scope: DEFAULT_SCOPE,
      });

      const lesson = pointAt(parsed(researchLesson()), [
        repoSrc.sourceId,
        stray,
      ]);
      // The schema has no registry: a syntactically valid id passes.
      expect(() => parsed(lesson)).not.toThrow();

      const view = multiView(harness.registry, [generationId]);
      expect(() => view.assertBelongsTo(stray)).toThrowError(
        expect.objectContaining({ code: "version_mismatch" }),
      );
      expect(view.get(stray)).toBeNull();
      expect(view.assertBelongsTo(repoSrc.sourceId)).toEqual(repoSrc);
    } finally {
      harness.close();
    }
  });

  it("keeps a comparison lesson's base and head evidence on different commits", async () => {
    const harness = await createEvidenceHarness();
    const { generationId, repoId } = sampleIds();
    const intruderSha = "e".repeat(40);

    try {
      harness.repos.repos.upsert({
        repoId,
        identity: `local:/tmp/${repoId}`,
        kind: "local",
        mirrorPath: `/tmp/${repoId}.git`,
        remoteUrl: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      harness.repos.generations.insertPublished(
        makeGeneration({
          generationId,
          repoId,
          projectId: null,
          kind: "comparison",
          commitSha: OTHER_HEAD_SHA,
          comparisonBaseSha: BASE_SHA,
        }),
      );
      harness.registry.bindGeneration(generationId);

      const baseSrc = await harness.registry.registerRepo({
        generationId,
        repoId,
        commitSha: BASE_SHA,
        path: "src/inventory.ts",
        lines: null,
        snapshot: fakeSnapshot(
          { "src/inventory.ts": "export interface Item { copies: number }\n" },
          { commitSha: BASE_SHA, repoId },
        ),
        scope: DEFAULT_SCOPE,
      });
      const headSrc = await harness.registry.registerRepo({
        generationId,
        repoId,
        commitSha: OTHER_HEAD_SHA,
        path: "src/stock.ts",
        lines: null,
        snapshot: fakeSnapshot(
          { "src/stock.ts": "export interface Item { quantity: number }\n" },
          { commitSha: OTHER_HEAD_SHA, repoId },
        ),
        scope: DEFAULT_SCOPE,
      });
      const intruder = await harness.registry.registerRepo({
        generationId,
        repoId,
        commitSha: intruderSha,
        path: "src/stray.ts",
        lines: null,
        snapshot: fakeSnapshot(
          { "src/stray.ts": "export const stray = true;\n" },
          { commitSha: intruderSha, repoId },
        ),
        scope: DEFAULT_SCOPE,
      });

      const draft = comparisonLesson();
      const context = draft.context as Record<string, unknown>;
      context.commitSha = OTHER_HEAD_SHA;
      const lesson = pointAt(parsed(draft), [
        baseSrc.sourceId,
        headSrc.sourceId,
      ]);
      const roundTripped = parsed(lesson);
      if (roundTripped.kind !== "comparison") {
        throw new Error("expected a comparison lesson");
      }
      expect(roundTripped.context.comparison.base.commitSha).toBe(BASE_SHA);
      expect(roundTripped.context.comparison.head.commitSha).toBe(
        OTHER_HEAD_SHA,
      );
      expect(baseSrc.sourceId).not.toBe(headSrc.sourceId);

      const view = multiView(harness.registry, [generationId]);
      expect([...view.allowedCommitShas()].sort()).toEqual(
        [BASE_SHA, OTHER_HEAD_SHA].sort(),
      );
      expect(view.assertBelongsTo(baseSrc.sourceId)).toEqual(baseSrc);
      expect(view.assertBelongsTo(headSrc.sourceId)).toEqual(headSrc);
      expect(() => view.assertBelongsTo(intruder.sourceId)).toThrowError(
        expect.objectContaining({ code: "version_mismatch" }),
      );
    } finally {
      harness.close();
    }
  });

  it("records source_missing without fabricating an external ref or metadata", async () => {
    const harness = await createEvidenceHarness();
    const { generationId, repoId } = sampleIds();

    try {
      const repoSrc = await harness.registry.registerRepo({
        generationId,
        repoId,
        commitSha: HEAD_SHA,
        path: "src/lmp/state/snapshot_cache.py",
        lines: null,
        snapshot: fakeSnapshot(
          { "src/lmp/state/snapshot_cache.py": "class SnapshotCache: ...\n" },
          { commitSha: HEAD_SHA, repoId },
        ),
        scope: DEFAULT_SCOPE,
      });
      harness.registry.bindGeneration(generationId);

      let failure: unknown;
      try {
        harness.registry.registerExternal({
          ok: false,
          status: "source_missing",
          reason: "not_found",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LearningError);
      expect((failure as LearningError).code).toBe(
        "external_source_unavailable",
      );

      harness.registry.recordGap(generationId, {
        kind: "external",
        status: "source_missing",
        subject: "attention mechanism background",
        reason: "not_found",
      });

      // The failed fetch staged no external ref; the repo ref is untouched.
      const staged = harness.registry.all(generationId);
      expect(staged).toEqual([repoSrc]);
      expect(staged.some((ref) => ref.kind === "external")).toBe(false);

      const gaps = harness.registry.gaps(generationId);
      expect(gaps).toEqual([
        {
          kind: "external",
          status: "source_missing",
          subject: "attention mechanism background",
          reason: "not_found",
        },
      ]);
      expect(Object.keys(gaps[0]!).sort()).toEqual([
        "kind",
        "reason",
        "status",
        "subject",
      ]);
      expect(JSON.stringify(gaps)).not.toMatch(/https?:/u);
      expect(JSON.stringify(gaps)).not.toMatch(/s_[0-9a-f]+/u);

      // A lesson may publish with the gap recorded; only the gap text travels.
      const draft = researchLesson();
      draft.evidence = [];
      draft.coverageGaps = ["外部资料缺失：attention mechanism（source_missing）"];
      const lesson = parsed(draft);
      expect(lesson.coverageGaps).toHaveLength(1);
      expect(lesson.evidence).toEqual([]);
    } finally {
      harness.close();
    }
  });
});
