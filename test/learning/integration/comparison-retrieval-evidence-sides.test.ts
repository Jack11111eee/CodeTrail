import { describe, expect, it } from "vitest";

import type {
  Binding,
  GenerationId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { validateEvidence } from "../../../src/learning/lessons/validate/evidence.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createRetriever } from "../../../src/learning/retrieval/search.ts";
import { createSourceSearcher } from "../../../src/learning/retrieval/source-search.ts";
import {
  fakeRegistry,
  fakeSnapshot,
  makeContext,
} from "../helpers/lesson-context.ts";
import {
  BASE_SHA,
  comparisonLesson,
  defaultGeneration,
  emptyCoverage,
} from "../helpers/lesson-sample.ts";
import { contextFor } from "../retrieval/retrieval-helpers.ts";

/**
 * Integration: two-commit retrieval (issue-18) → comparison evidence sides
 * (issue-17, AC-LES-08 / AC-R16-01).
 *
 * A comparison binding makes the retriever search the head and base snapshots.
 * The hits it returns carry only `{path, lines}`, so the lesson side is decided
 * by the path (and by the commit the caller registers the ref against). This
 * suite proves the retrieval ordering, the registry identity and the
 * base/head side rules all line up — and that neither half silently accepts a
 * citation from the wrong commit.
 */

const PLACEHOLDER_SOURCE_ID = "s_0123456789abcdef";
const HEAD_TEXT = [
  "export const quantity = 3;",
  "export function stock() {}",
  "",
].join("\n");
const BASE_TEXT = [
  "export const copies = 3;",
  "export function inventory() {}",
  "",
].join("\n");

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

interface ComparisonPayloadOptions {
  headRefId: string;
  baseRefId: string;
  headGenerationId: GenerationId;
  baseGenerationId: GenerationId;
  headCommit: string;
  baseCommit: string;
  repoId: RepoId;
}

function comparisonPayload(options: ComparisonPayloadOptions): unknown {
  const raw = remapSourceId(comparisonLesson(), options.headRefId) as Record<
    string,
    unknown
  >;

  raw.context = {
    repoId: options.repoId,
    commitSha: options.headCommit,
    generationId: options.headGenerationId,
    scenarioId: "sc_0123456789abcdef",
    moduleIds: ["src"],
    comparison: {
      base: {
        repoId: options.repoId,
        commitSha: options.baseCommit,
        generationId: options.baseGenerationId,
      },
      head: {
        repoId: options.repoId,
        commitSha: options.headCommit,
        generationId: options.headGenerationId,
      },
    },
  };
  raw.statements = [
    {
      id: "st1",
      label: "code_fact",
      text: "新版本导出 quantity。",
      evidenceIds: [options.headRefId],
      side: "head",
    },
    {
      id: "st2",
      label: "code_fact",
      text: "旧版本导出 copies。",
      evidenceIds: [options.baseRefId],
      side: "base",
    },
  ];
  raw.evidence = [options.headRefId, options.baseRefId];
  raw.choices = [];
  raw.choicesOmittedReason = "两个版本都没有可比较的替代实现";
  raw.boundaries = [];
  raw.diagram = {
    kind: "state",
    mermaid: "stateDiagram-v2\n  [*] --> copies\n  copies --> quantity",
    nodes: [
      {
        id: "n1",
        label: "quantity",
        evidenceIds: [options.headRefId],
        status: "observed",
      },
    ],
    edges: [],
  };

  return raw;
}

function mutateStatements(
  payload: unknown,
  mutate: (statements: { evidenceIds: string[] }[]) => void,
): unknown {
  const copy = JSON.parse(JSON.stringify(payload)) as {
    statements: { evidenceIds: string[] }[];
    evidence?: string[];
  };
  mutate(copy.statements);
  return copy;
}

function hitWithMarker(
  hits: {
    path?: string;
    lines?: { start: number; end: number };
    preview: string;
  }[],
  marker: string,
): { path?: string; lines?: { start: number; end: number }; preview: string } {
  const hit = hits.find((candidate) => candidate.preview.includes(marker));
  if (hit === undefined) {
    throw new Error(`no retrieval hit for marker ${marker}`);
  }
  return hit;
}

describe("two-commit retrieval feeds both comparison sides", () => {
  it("returns one hit per commit and both citations validate on their own side", async () => {
    const head = defaultGeneration();
    const base = defaultGeneration({
      generationId: "g_base0123456789ab" as GenerationId,
      commitSha: BASE_SHA,
    });
    const headSnapshot = fakeSnapshot(
      { "src/stock.ts": HEAD_TEXT },
      { commitSha: head.commitSha, repoId: head.repoId },
    );
    const baseSnapshot = fakeSnapshot(
      { "src/legacy/inventory.ts": BASE_TEXT },
      { commitSha: base.commitSha, repoId: base.repoId },
    );
    const binding: Binding = {
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: head.commitSha,
      comparisonBaseSha: BASE_SHA,
    };

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => contextFor({}, { binding, snapshot: headSnapshot, baseSnapshot }),
    });

    const hits = await retriever.search(binding, "copies quantity");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const headHit = hits.find((hit) => hit.path === "src/stock.ts");
    const baseHit = hits.find((hit) => hit.path === "src/legacy/inventory.ts");
    expect(headHit, "the head snapshot must be searched").toBeDefined();
    expect(baseHit, "the base snapshot must be searched").toBeDefined();

    // Retrieval always reports the requested binding; the commit side lives on
    // the ref the caller registers from the hit's path (documented debt: the
    // frozen RetrievalHit contract has no per-hit commit field).
    expect(headHit!.binding).toEqual(binding);
    expect(baseHit!.binding).toEqual(binding);
    expect(hits[0].path).toBe("src/stock.ts");

    const registry = fakeRegistry();
    const headRef = await registry.registerRepo({
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: head.commitSha,
      path: headHit!.path!,
      lines: headHit!.lines!,
      snapshot: headSnapshot,
      scope: normalizeScope(),
    });
    const baseRef = await registry.registerRepo({
      generationId: head.generationId,
      repoId: base.repoId,
      commitSha: base.commitSha,
      path: baseHit!.path!,
      lines: baseHit!.lines!,
      snapshot: baseSnapshot,
      scope: normalizeScope(),
    });
    expect(baseRef.sourceId).not.toBe(headRef.sourceId);

    const payload = comparisonPayload({
      headRefId: headRef.sourceId,
      baseRefId: baseRef.sourceId,
      headGenerationId: head.generationId,
      baseGenerationId: base.generationId,
      headCommit: head.commitSha,
      baseCommit: base.commitSha,
      repoId: head.repoId,
    });
    const parsed = parseLesson(payload);
    expect(parsed.ok, "comparison lesson must parse").toBe(true);
    if (!parsed.ok) return;

    const ctx = makeContext({
      mode: "comparison",
      generation: head,
      registry,
      snapshot: headSnapshot,
      baseSnapshot,
      allowedCommitShas: [head.commitSha, base.commitSha],
      coverage: emptyCoverage([headHit!.path!, baseHit!.path!]),
    });
    const ok = await validateEvidence(parsed.lesson, ctx);
    expect(ok.issues).toEqual([]);
    expect(ok.ok).toBe(true);

    // Flipping the head statement onto the base ref must be refused.
    const flipped = mutateStatements(payload, (statements) => {
      statements[0].evidenceIds = [baseRef.sourceId];
    });
    const flippedParsed = parseLesson(flipped);
    expect(flippedParsed.ok).toBe(true);
    if (!flippedParsed.ok) return;
    const bad = await validateEvidence(flippedParsed.lesson, ctx);
    expect(bad.ok).toBe(false);
    expect(
      bad.issues.some(
        (issue) =>
          issue.code === "evidence_compare" &&
          issue.message.includes("head statement cites"),
      ),
      "a head-side statement may not cite the base commit",
    ).toBe(true);
  });

  it("keeps the same path and line range distinguishable across commits", async () => {
    const head = defaultGeneration();
    const base = defaultGeneration({
      generationId: "g_base0123456789ab" as GenerationId,
      commitSha: BASE_SHA,
    });
    // Only line 2 mentions the query, so each commit contributes exactly one
    // hit at the same path and line range.
    const headSnapshot = fakeSnapshot(
      { "src/app.py": "import os\nRETRY = 3\nVALUE = 30\n" },
      { commitSha: head.commitSha, repoId: head.repoId },
    );
    const baseSnapshot = fakeSnapshot(
      { "src/app.py": "import os\nRETRY = 1\nVALUE = 10\n" },
      { commitSha: base.commitSha, repoId: base.repoId },
    );
    const binding: Binding = {
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: head.commitSha,
      comparisonBaseSha: BASE_SHA,
    };

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => contextFor({}, { binding, snapshot: headSnapshot, baseSnapshot }),
    });
    const hits = await retriever.search(binding, "RETRY");
    const samePath = hits.filter((hit) => hit.path === "src/app.py");
    expect(
      samePath.length,
      "both commits contribute a hit for the same path",
    ).toBe(2);
    expect(samePath[0].lines).toEqual(samePath[1].lines);
    expect(samePath[0].preview).not.toBe(samePath[1].preview);
    expect(samePath[0].preview, "head is searched first").toContain("3");
    expect(samePath[1].preview).toContain("1");

    const registry = fakeRegistry();
    // Register each hit against the commit whose bytes produced it.
    const headHit = hitWithMarker(samePath, "3");
    const baseHit = hitWithMarker(samePath, "1");
    const headRef = await registry.registerRepo({
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: head.commitSha,
      path: headHit.path!,
      lines: headHit.lines!,
      snapshot: headSnapshot,
      scope: normalizeScope(),
    });
    const baseRef = await registry.registerRepo({
      generationId: head.generationId,
      repoId: base.repoId,
      commitSha: base.commitSha,
      path: baseHit.path!,
      lines: baseHit.lines!,
      snapshot: baseSnapshot,
      scope: normalizeScope(),
    });
    expect(headRef.sourceId).toBe(
      repoSourceId("src/app.py", head.commitSha, headHit.lines!),
    );
    expect(baseRef.sourceId).toBe(
      repoSourceId("src/app.py", base.commitSha, baseHit.lines!),
    );
    expect(headRef.sourceId).not.toBe(baseRef.sourceId);

    const payload = comparisonPayload({
      headRefId: headRef.sourceId,
      baseRefId: baseRef.sourceId,
      headGenerationId: head.generationId,
      baseGenerationId: base.generationId,
      headCommit: head.commitSha,
      baseCommit: base.commitSha,
      repoId: head.repoId,
    });
    const parsed = parseLesson(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const ctx = makeContext({
      mode: "comparison",
      generation: head,
      registry,
      snapshot: headSnapshot,
      baseSnapshot,
      allowedCommitShas: [head.commitSha, base.commitSha],
      coverage: emptyCoverage(["src/app.py"]),
    });
    expect((await validateEvidence(parsed.lesson, ctx)).ok).toBe(true);

    // A single unversioned id on both sides must not pass.
    const unversioned = mutateStatements(payload, (statements) => {
      statements[1].evidenceIds = [headRef.sourceId];
    });
    const unversionedParsed = parseLesson(unversioned);
    expect(unversionedParsed.ok).toBe(true);
    if (!unversionedParsed.ok) return;
    const bad = await validateEvidence(unversionedParsed.lesson, ctx);
    expect(bad.ok).toBe(false);
    expect(
      bad.issues.some((issue) => issue.code === "evidence_compare"),
      "a shared id cannot describe two different commits",
    ).toBe(true);
  });
});

describe("retrieval and the gate agree about a foreign base", () => {
  it("rejects a mismatched base snapshot on both sides of the boundary", async () => {
    const head = defaultGeneration();
    const binding: Binding = {
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: head.commitSha,
      comparisonBaseSha: BASE_SHA,
    };
    const headSnapshot = fakeSnapshot(
      { "src/app.py": HEAD_TEXT },
      { commitSha: head.commitSha, repoId: head.repoId },
    );
    const foreignBase = fakeSnapshot(
      { "src/app.py": BASE_TEXT },
      { commitSha: "d".repeat(40), repoId: head.repoId },
    );

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () =>
        contextFor({}, { binding, snapshot: headSnapshot, baseSnapshot: foreignBase }),
    });

    await expect(retriever.search(binding, "quantity")).rejects.toMatchObject({
      code: "version_mismatch",
    });

    // The lesson gate must also refuse a base ref whose commit is not allowed.
    const registry = fakeRegistry();
    const baseRef = await registry.registerRepo({
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: BASE_SHA,
      path: "src/app.py",
      lines: { start: 1, end: 1 },
      snapshot: fakeSnapshot(
        { "src/app.py": BASE_TEXT },
        { commitSha: BASE_SHA, repoId: head.repoId },
      ),
      scope: normalizeScope(),
    });
    const headRef = await registry.registerRepo({
      generationId: head.generationId,
      repoId: head.repoId,
      commitSha: head.commitSha,
      path: "src/app.py",
      lines: { start: 1, end: 1 },
      snapshot: headSnapshot,
      scope: normalizeScope(),
    });

    const payload = comparisonPayload({
      headRefId: headRef.sourceId,
      baseRefId: baseRef.sourceId,
      headGenerationId: head.generationId,
      baseGenerationId: "g_base0123456789ab" as GenerationId,
      headCommit: head.commitSha,
      baseCommit: BASE_SHA,
      repoId: head.repoId,
    });
    const parsed = parseLesson(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const ctx = makeContext({
      mode: "comparison",
      generation: head,
      registry,
      snapshot: headSnapshot,
      baseSnapshot: null,
      allowedCommitShas: [head.commitSha],
      coverage: emptyCoverage(["src/app.py"]),
    });
    const result = await validateEvidence(parsed.lesson, ctx);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "evidence_compare" || issue.code === "evidence_repo",
      ),
    ).toBe(true);
    expect(
      result.issues.some((issue) => issue.message.includes("does not belong")),
    ).toBe(true);
  });
});
