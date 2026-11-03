/**
 * AC-R16-01: two versions of the same path at the same line numbers stay
 * distinguishable. Each side keeps its own `commit_sha` and content hash, and
 * a comparison lesson may not cite the other side or an unversioned ref.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ComparisonLesson,
  DiffResult,
  GenerationId,
  JobId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import { stagedRef } from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { buildComparisonLesson } from "../../../src/learning/lessons/builder.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { validateEvidence } from "../../../src/learning/lessons/validate/evidence.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  cleanupScripts,
  fakeRegistry,
  fakeSnapshot,
  fixedClock,
  lessonEntry,
  makeContext,
  okMermaid,
  repoRef,
  scriptedHandle,
  scriptDir,
  stubExternal,
} from "../helpers/lesson-context.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  comparisonLesson,
  defaultGeneration,
  emptyCoverage,
} from "../helpers/lesson-sample.ts";
import {
  fixturePath,
  fixtureSha,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = "evolution";
const CHECKOUT = "src/checkout.ts";
const README = "README.md";
const REPO_ID = "r_r16_samelines01" as RepoId;
const GENERATION_ID = "g_r16_samelines01" as GenerationId;

let workDir = "";

beforeAll(() => {
  if (!existsSync(path.join(fixturesDir(), "manifest.json"))) {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  }
  requireFixtures();
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r16a-"));
}, 180_000);

afterAll(() => {
  cleanupScripts();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

function readAt(commitSha: string, relPath: string): string {
  return execFileSync(
    "git",
    ["-C", fixturePath(FIXTURE), "show", `${commitSha}:${relPath}`],
    { encoding: "utf8" },
  );
}

describe("AC-R16-01 — same lines, distinct versions", () => {
  it("keeps the base and head refs distinguishable at the same path and lines", async () => {
    const generation = defaultGeneration();
    const registry = fakeRegistry();
    const baseLine = 'import { InventoryItem } from "./inventory.js";';
    const headLine = 'import { InventoryItem } from "./stock.js";';
    const baseRef = repoRef({
      path: CHECKOUT,
      text: baseLine,
      lines: { start: 1, end: 1 },
      commitSha: BASE_SHA,
      generationId: generation.generationId,
      repoId: generation.repoId,
    });
    const headRef = repoRef({
      path: CHECKOUT,
      text: headLine,
      lines: { start: 1, end: 1 },
      commitSha: HEAD_SHA,
      generationId: generation.generationId,
      repoId: generation.repoId,
    });
    registry.add(generation.generationId, baseRef);
    registry.add(generation.generationId, headRef);

    const raw = structuredClone(comparisonLesson());
    raw.context = {
      repoId: generation.repoId,
      commitSha: HEAD_SHA,
      generationId: generation.generationId,
      scenarioId: "sc_same_lines",
      moduleIds: ["src"],
      comparison: {
        base: {
          repoId: generation.repoId,
          commitSha: BASE_SHA,
          generationId: "g_r16_base00000001",
        },
        head: {
          repoId: generation.repoId,
          commitSha: HEAD_SHA,
          generationId: generation.generationId,
        },
      },
    };
    raw.statements = [
      {
        id: "st_head",
        label: "code_fact",
        text: "B 版本从 ./stock.js 导入。",
        evidenceIds: [headRef.sourceId],
        side: "head",
      },
      {
        id: "st_base",
        label: "code_fact",
        text: "A 版本从 ./inventory.js 导入。",
        evidenceIds: [baseRef.sourceId],
        side: "base",
      },
    ];
    raw.evidence = [headRef.sourceId, baseRef.sourceId];
    raw.choices = [];
    raw.choicesOmittedReason = "两个版本只差导入路径";
    raw.boundaries = [];
    raw.diagram = {
      kind: "state",
      mermaid: "stateDiagram-v2\n  [*] --> inventory\n  inventory --> stock",
      nodes: [
        {
          id: "n1",
          label: "inventory",
          evidenceIds: [baseRef.sourceId],
          status: "observed",
        },
        {
          id: "n2",
          label: "stock",
          evidenceIds: [headRef.sourceId],
          status: "observed",
        },
      ],
      edges: [],
    };
    const parsed = parseLesson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const lesson = parsed.lesson as ComparisonLesson;

    const ctx = makeContext({
      mode: "comparison",
      generation,
      registry,
      snapshot: fakeSnapshot(
        { [CHECKOUT]: headLine },
        { commitSha: HEAD_SHA, repoId: generation.repoId },
      ),
      baseSnapshot: fakeSnapshot(
        { [CHECKOUT]: baseLine },
        { commitSha: BASE_SHA, repoId: generation.repoId },
      ),
      allowedCommitShas: [HEAD_SHA, BASE_SHA],
      coverage: emptyCoverage([CHECKOUT]),
    });

    expect(baseRef.path).toBe(headRef.path);
    expect(baseRef.lines).toEqual(headRef.lines);
    expect(baseRef.lines).toEqual({ start: 1, end: 1 });
    expect(baseRef.commitSha).not.toBe(headRef.commitSha);
    expect(baseRef.contentHash).not.toBe(headRef.contentHash);
    expect(baseRef.sourceId).not.toBe(headRef.sourceId);

    await expect(validateEvidence(lesson, ctx)).resolves.toMatchObject({
      ok: true,
    });

    // An "unversioned" comparison — both sides naming one commit — is rejected.
    const sameCommit = structuredClone(lesson);
    sameCommit.context.comparison.head.commitSha =
      sameCommit.context.comparison.base.commitSha;
    const unversioned = await validateEvidence(sameCommit, ctx);
    expect(unversioned.ok).toBe(false);
    expect(
      unversioned.issues.some((entry) =>
        entry.message.includes("base and head must name different commits"),
      ),
    ).toBe(true);

    // A head statement citing the base ref is rejected, not silently accepted.
    const crossed = structuredClone(lesson);
    crossed.statements = crossed.statements.map((statement) =>
      statement.side === "head"
        ? { ...statement, evidenceIds: [baseRef.sourceId] }
        : statement,
    );
    const crossedResult = await validateEvidence(crossed, ctx);
    expect(crossedResult.ok).toBe(false);
    expect(
      crossedResult.issues.some((entry) =>
        entry.message.includes("head statement cites a"),
      ),
    ).toBe(true);
  });

  it("builds a comparison lesson whose two refs share a path but not a commit or hash", async () => {
    const baseSha = fixtureSha(FIXTURE, "HEAD~1");
    const headSha = fixtureSha(FIXTURE, "HEAD");
    const baseFiles = { [CHECKOUT]: readAt(baseSha, CHECKOUT) };
    const headFiles = { [CHECKOUT]: readAt(headSha, CHECKOUT) };
    expect(baseFiles[CHECKOUT]).not.toBe(headFiles[CHECKOUT]);

    const headRef = repoSourceId(CHECKOUT, headSha, null);
    const baseRef = repoSourceId(CHECKOUT, baseSha, null);
    const diff: DiffResult = {
      entries: [
        { path: "src/stock.ts", status: "R", oldPath: "src/inventory.ts" },
        { path: CHECKOUT, status: "M" },
      ],
      truncated: false,
      gaps: [],
    };

    const payload = structuredClone(comparisonLesson());
    payload.lessonId = "l_r16_samelines01";
    payload.statements = [
      {
        id: "st_head",
        label: "code_fact",
        text: "B 版本的 checkout 从 ./stock.js 导入。",
        evidenceIds: [headRef],
        side: "head",
      },
      {
        id: "st_base",
        label: "code_fact",
        text: "A 版本的 checkout 从 ./inventory.js 导入。",
        evidenceIds: [baseRef],
        side: "base",
      },
    ];
    payload.evidence = [headRef, baseRef];
    payload.choices = [];
    payload.choicesOmittedReason = "两个版本只差导入路径，没有可比较的替代设计";
    payload.boundaries = [];
    payload.diagram = {
      kind: "state",
      mermaid: "stateDiagram-v2\n  [*] --> inventory\n  inventory --> stock",
      nodes: [
        {
          id: "n1",
          label: "inventory.ts",
          evidenceIds: [baseRef],
          status: "observed",
        },
        {
          id: "n2",
          label: "stock.ts",
          evidenceIds: [headRef],
          status: "observed",
        },
      ],
      edges: [],
    };

    const registry = fakeRegistry();
    const generation = stagedRef({
      generationId: GENERATION_ID,
      repoId: REPO_ID,
      commitSha: headSha,
      knowledgeDir: path.join(workDir, "knowledge"),
      jobId: "j_r16_samelines01" as JobId,
      baseContextSha: baseSha,
    });
    const base = stagedRef({
      generationId: "g_r16_base00000001" as GenerationId,
      repoId: REPO_ID,
      commitSha: baseSha,
      knowledgeDir: path.join(workDir, "knowledge-base"),
      jobId: "j_r16_base00000001" as JobId,
      baseContextSha: null,
    });

    const result = await buildComparisonLesson(
      {
        generation,
        base,
        head: generation,
        diff,
        baseSnapshot: fakeSnapshot(baseFiles, {
          commitSha: baseSha,
          repoId: REPO_ID,
        }),
        headSnapshot: fakeSnapshot(headFiles, {
          commitSha: headSha,
          repoId: REPO_ID,
        }),
        scope: normalizeScope(),
        coverage: emptyCoverage([CHECKOUT]),
        model: scriptedHandle(scriptDir([lessonEntry(payload)])),
        registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { mermaid: okMermaid() },
    );

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);

    const refs = registry
      .all(GENERATION_ID)
      .filter((ref) => ref.kind === "repo" && ref.path === CHECKOUT);
    expect(refs).toHaveLength(2);
    const commits = refs.map((ref) =>
      ref.kind === "repo" ? ref.commitSha : "",
    );
    expect(new Set(commits)).toEqual(new Set([baseSha, headSha]));
    const hashes = refs.map((ref) =>
      ref.kind === "repo" ? ref.contentHash : "",
    );
    expect(new Set(hashes).size).toBe(2);
    for (const ref of refs) {
      if (ref.kind === "repo") {
        expect(ref.commitSha).not.toBe("");
        expect(ref.path).toBe(CHECKOUT);
      }
    }
  }, 120_000);

  it("keeps two refs when both commits hold byte-identical content at one path", async () => {
    const baseSha = fixtureSha(FIXTURE, "HEAD~1");
    const headSha = fixtureSha(FIXTURE, "HEAD");
    const baseText = readAt(baseSha, README);
    const headText = readAt(headSha, README);
    // The rename commit leaves README untouched: same bytes, same path.
    expect(headText).toBe(baseText);

    const generation = defaultGeneration();
    const registry = fakeRegistry();
    const baseRef = repoRef({
      path: README,
      text: baseText,
      lines: null,
      commitSha: BASE_SHA,
      generationId: generation.generationId,
      repoId: generation.repoId,
    });
    const headRef = repoRef({
      path: README,
      text: headText,
      lines: null,
      commitSha: HEAD_SHA,
      generationId: generation.generationId,
      repoId: generation.repoId,
    });
    registry.add(generation.generationId, baseRef);
    registry.add(generation.generationId, headRef);

    // Identity cannot come from the content hash here — only the commit can
    // tell the two sides apart.
    expect(baseRef.contentHash).toBe(headRef.contentHash);
    expect(baseRef.sourceId).not.toBe(headRef.sourceId);
    expect(repoSourceId(README, baseSha, null)).not.toBe(
      repoSourceId(README, headSha, null),
    );

    const raw = structuredClone(comparisonLesson());
    raw.context = {
      repoId: generation.repoId,
      commitSha: HEAD_SHA,
      generationId: generation.generationId,
      scenarioId: "sc_identical_bytes",
      moduleIds: ["src"],
      comparison: {
        base: {
          repoId: generation.repoId,
          commitSha: BASE_SHA,
          generationId: "g_r16_base00000001",
        },
        head: {
          repoId: generation.repoId,
          commitSha: HEAD_SHA,
          generationId: generation.generationId,
        },
      },
    };
    raw.statements = [
      {
        id: "st_head",
        label: "code_fact",
        text: "B 版本的 README 与 A 版本内容相同。",
        evidenceIds: [headRef.sourceId],
        side: "head",
      },
      {
        id: "st_base",
        label: "code_fact",
        text: "A 版本的 README 与 B 版本内容相同。",
        evidenceIds: [baseRef.sourceId],
        side: "base",
      },
    ];
    raw.evidence = [headRef.sourceId, baseRef.sourceId];
    raw.choices = [];
    raw.choicesOmittedReason = "两版本内容相同，没有可比较的替代设计";
    raw.boundaries = [];
    raw.diagram = {
      kind: "state",
      mermaid: "stateDiagram-v2\n  [*] --> readme",
      nodes: [
        {
          id: "n1",
          label: "README (A)",
          evidenceIds: [baseRef.sourceId],
          status: "observed",
        },
        {
          id: "n2",
          label: "README (B)",
          evidenceIds: [headRef.sourceId],
          status: "observed",
        },
      ],
      edges: [],
    };
    const parsed = parseLesson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const ctx = makeContext({
      mode: "comparison",
      generation,
      registry,
      snapshot: fakeSnapshot(
        { [README]: headText },
        { commitSha: HEAD_SHA, repoId: generation.repoId },
      ),
      baseSnapshot: fakeSnapshot(
        { [README]: baseText },
        { commitSha: BASE_SHA, repoId: generation.repoId },
      ),
      allowedCommitShas: [HEAD_SHA, BASE_SHA],
      coverage: emptyCoverage([README]),
    });

    await expect(validateEvidence(parsed.lesson, ctx)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      registry
        .all(generation.generationId)
        .filter((ref) => ref.kind === "repo" && ref.path === README),
    ).toHaveLength(2);
  });
});
