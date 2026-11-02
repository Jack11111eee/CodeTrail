import { afterEach, describe, expect, it } from "vitest";

import {
  LearningError,
  type ChangeRecord,
  type DiffResult,
  type GenerationId,
  type Lesson,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import {
  buildChangeLesson,
  buildComparisonLesson,
} from "../../../src/learning/lessons/builder.ts";
import {
  cleanupScripts,
  changeFixture,
  comparisonFixture,
  fakeRegistry,
  fakeSnapshot,
  fixedClock,
  lessonEntry,
  okMermaid,
  scriptedHandle,
  scriptDir,
  stubExternal,
} from "../helpers/lesson-context.ts";
import {
  BASE_SHA,
  defaultGeneration,
  emptyCoverage,
} from "../helpers/lesson-sample.ts";

afterEach(cleanupScripts);

const DIFF: DiffResult = {
  entries: [{ path: "src/index.ts", status: "M" }],
  truncated: false,
  gaps: [],
};

const INDEX_HEAD = [
  "export function slugify(value: string): string {",
  "  return value.trim().toLowerCase();",
  "}",
].join("\n");

const INDEX_BASE = `${INDEX_HEAD}\n// base side`;
const INDEX_HEAD_SIDE = `${INDEX_HEAD}\n// head side`;

function changeEvent(overrides: Record<string, unknown> = {}): ChangeRecord {
  return {
    eventId: "e_0123456789abcdef",
    eventKey: "pr-1",
    repoId: "r_0123456789abcdef",
    projectId: "p_0123456789abcdef",
    streamId: "main",
    streamKind: "branch",
    kind: "commits",
    baseSha: BASE_SHA,
    headSha: "a".repeat(40),
    mergeBaseSha: BASE_SHA,
    baseContextSha: null,
    significance: "major",
    state: "detected",
    jobId: null,
    gapReason: null,
    linkedEventId: null,
    linkRelation: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    publishedAt: null,
    payload: { kind: "commits", headSha: "a".repeat(40) },
    ...overrides,
  } as unknown as ChangeRecord;
}

/** Swaps a fixture's placeholder source id for a whole-file source id. */
function remapEvidence(lesson: unknown, from: string, to: string): unknown {
  return JSON.parse(
    JSON.stringify(lesson).replaceAll(from, to),
  ) as unknown;
}

/**
 * Every id the published lesson cites must resolve to a ref the builder staged.
 * This is what the shared fixtures' pre-populated registry used to hide.
 */
function expectCitationsRegistered(lesson: Lesson, sourceIds: Iterable<string>): void {
  const registered = new Set(sourceIds);
  const cited = [
    ...lesson.evidence,
    ...lesson.statements.flatMap((statement) => statement.evidenceIds),
    ...lesson.choices.flatMap((choice) => [
      ...choice.evidenceIds,
      ...choice.alternatives.flatMap((alternative) => alternative.evidenceIds),
    ]),
    ...lesson.boundaries.flatMap((boundary) => boundary.evidenceIds),
    ...lesson.diagram.nodes.flatMap((node) => node.evidenceIds),
    ...lesson.diagram.edges.flatMap((edge) => edge.evidenceIds),
  ];

  for (const sourceId of cited) {
    expect(registered.has(sourceId)).toBe(true);
  }
}

/**
 * The change and comparison entry points must stage their own evidence sources.
 * The registry starts empty here and is only filled by the builder itself.
 */
describe("change builder", () => {
  it("registers diff sources and publishes a valid change lesson", async () => {
    const fixture = changeFixture();
    const generation = fixture.ctx.generation;
    const registry = fakeRegistry();
    const headSourceId = repoSourceId(
      "src/index.ts",
      generation.commitSha,
      null,
    );
    const lesson = remapEvidence(
      fixture.lesson,
      fixture.ref.sourceId,
      headSourceId,
    );
    const dir = scriptDir([lessonEntry(lesson)]);
    const model = scriptedHandle(dir);

    const result = await buildChangeLesson(
      {
        generation,
        event: changeEvent(),
        diff: DIFF,
        baseSnapshot: null,
        headSnapshot: fakeSnapshot(
          { "src/index.ts": INDEX_HEAD },
          { commitSha: generation.commitSha, repoId: generation.repoId },
        ),
        scope: fixture.ctx.scope,
        model,
        registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { mermaid: okMermaid() },
    );

    expect(result.failures).toEqual([]);
    expect(result.blankTeaching).toBe(false);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].kind).toBe("change");

    const refs = registry.all(generation.generationId);
    expect(refs.length).toBeGreaterThan(0);
    expectCitationsRegistered(
      result.lessons[0],
      refs.map((ref) => ref.sourceId),
    );
  });
});

describe("comparison builder", () => {
  it("registers both commit sides and publishes a valid comparison lesson", async () => {
    const fixture = comparisonFixture();
    const head = defaultGeneration();
    const base = defaultGeneration({
      generationId: "g_base0123456789ab" as GenerationId,
      commitSha: BASE_SHA,
    });
    const registry = fakeRegistry();
    const headSourceId = repoSourceId("src/index.ts", head.commitSha, null);
    const baseSourceId = repoSourceId("src/index.ts", base.commitSha, null);
    const lesson = remapEvidence(
      remapEvidence(
        fixture.lesson,
        fixture.headRef.sourceId,
        headSourceId,
      ),
      fixture.baseRef.sourceId,
      baseSourceId,
    );
    const dir = scriptDir([lessonEntry(lesson)]);
    const model = scriptedHandle(dir);

    const result = await buildComparisonLesson(
      {
        generation: head,
        base,
        head,
        diff: DIFF,
        baseSnapshot: fakeSnapshot(
          { "src/index.ts": INDEX_BASE },
          { commitSha: BASE_SHA, repoId: head.repoId },
        ),
        headSnapshot: fakeSnapshot(
          { "src/index.ts": INDEX_HEAD_SIDE },
          { commitSha: head.commitSha, repoId: head.repoId },
        ),
        scope: fixture.ctx.scope,
        coverage: emptyCoverage(["src/index.ts"]),
        model,
        registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { mermaid: okMermaid() },
    );

    expect(result.failures).toEqual([]);
    expect(result.blankTeaching).toBe(false);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].kind).toBe("comparison");

    const refs = registry.all(head.generationId);
    const sourceIds = refs.map((ref) => ref.sourceId);
    expect(sourceIds).toContain(headSourceId);
    expect(sourceIds).toContain(baseSourceId);
    expectCitationsRegistered(result.lessons[0], sourceIds);

    // AC-LES-08: both sides are independently versioned and both ids ship.
    const comparison = result.lessons[0] as Lesson & {
      baseGenerationId: GenerationId | null;
      headGenerationId: GenerationId | null;
    };
    expect(comparison.baseGenerationId).toBe(base.generationId);
    expect(comparison.headGenerationId).toBe(head.generationId);
  });
});

describe("registry failures", () => {
  it("surfaces a registry read error instead of degrading to blank teaching", async () => {
    const fixture = changeFixture();
    const generation = fixture.ctx.generation;
    const staged = fakeRegistry();
    const registry = {
      ...staged,
      all: (): never => {
        throw new LearningError("internal_error", "staging bucket unavailable");
      },
    };
    const dir = scriptDir([]);
    const model = scriptedHandle(dir);

    await expect(
      buildChangeLesson(
        {
          generation,
          event: changeEvent(),
          diff: DIFF,
          baseSnapshot: null,
          headSnapshot: fakeSnapshot(
            { "src/index.ts": INDEX_HEAD },
            { commitSha: generation.commitSha, repoId: generation.repoId },
          ),
          scope: fixture.ctx.scope,
          model,
          registry,
          external: stubExternal(),
          clock: fixedClock(),
        },
        { mermaid: okMermaid() },
      ),
    ).rejects.toBeInstanceOf(LearningError);
  });
});
