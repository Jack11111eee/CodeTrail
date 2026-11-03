/**
 * AC-R17-01: a lesson carries a macro view and a micro view of the same
 * mechanics. The component diagram is the macro map; the technical explanation
 * is the micro, code-level one. Both layers share one `mechanismId` per
 * mechanism and describe one worked example, and the same text may not be
 * copied between the two layers.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  CoverageReport,
  GenerationId,
  JobId,
  RepoId,
  UpstreamClaimsPort,
} from "../../../src/learning/contracts/index.ts";
import { stagedRef } from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { buildResearchLessons } from "../../../src/learning/lessons/builder.ts";
import {
  languageOf,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import {
  cleanupScripts,
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
  fixturePath,
  fixtureSha,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const FIXTURE = "last-mile-mini";
const CACHE = "src/lmp/state/snapshot_cache.py";
const REPO_ID = "r_r17_layers0001" as RepoId;
const GENERATION_ID = "g_r17_layers0001" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r17a-"));
}, 180_000);

afterAll(() => {
  cleanupScripts();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

function readFixture(relPath: string): string {
  return readFileSync(path.join(fixturePath(FIXTURE), relPath), "utf8");
}

function coverageFor(commitSha: string): CoverageReport {
  const analyzed = [
    {
      path: CACHE,
      bytes: Buffer.byteLength(readFixture(CACHE), "utf8"),
      language: languageOf(CACHE),
    },
  ];
  return {
    generationId: GENERATION_ID,
    commitSha,
    complete: true,
    analyzed,
    gaps: [],
    counts: {
      totalFiles: 1,
      analyzedFiles: 1,
      excludedFiles: 0,
    },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

const claimsPort = (commitSha: string): UpstreamClaimsPort => ({
  pages: () => Promise.resolve(["src"]),
  claimsFor: () =>
    Promise.resolve([
      {
        id: "c_cache",
        statement: "SnapshotCache caches and evicts snapshots",
        evidence: [{ resource: `repo://${CACHE}`, version: commitSha }],
      },
    ]),
  markdown: () => Promise.resolve(""),
});

function lessonPayload(
  commitSha: string,
  duplicateLayers = false,
): Record<string, unknown> {
  const cacheId = repoSourceId(CACHE, commitSha, null);
  const evictPlain = "缓存满了就丢掉旧快照，下一次读取会重建。";
  const evictTechnical =
    "SnapshotCache.evict() 调用 self._entries.pop(shipment_id, None) 删除条目。";
  return {
    lessonId: "l_r17_layers0001",
    scenario: {
      id: "sc_snapshot_eviction",
      kind: "library_interface",
      inputs: ["shipment_id"],
      userAction: "调用缓存读取审批快照",
      observableResult: "读取到与当前状态一致的新快照",
      isExample: true,
    },
    overview: [
      {
        moduleId: "src",
        responsibility: "缓存并按需淘汰审批快照",
        inputs: ["shipment_id"],
        outputs: ["approval snapshot"],
      },
    ],
    plainExplanation: [
      { mechanismId: "m_evict", text: evictPlain },
      {
        mechanismId: "m_rebuild",
        text: "重建时从当前状态重新计算审批结果。",
      },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_evict",
        terms: [{ zh: "淘汰", en: "evict", symbol: "evict" }],
        text: duplicateLayers ? evictPlain : evictTechnical,
      },
      {
        mechanismId: "m_rebuild",
        terms: [{ zh: "重建", en: "rebuild", symbol: "get" }],
        text: "下一次 get() 返回 None，调用方必须重新构造快照并写回缓存。",
      },
    ],
    choices: [],
    choicesOmittedReason: "缓存只有字典一种实现，没有可比较的替代方案",
    boundaries: [
      {
        item: "只按 shipment_id 缓存",
        status: "implemented",
        limits: "同一 shipment_id 的旧快照会被覆盖",
        evidenceIds: [cacheId],
      },
    ],
    statements: [
      {
        id: "st_evict",
        label: "code_fact",
        text: "SnapshotCache.evict() 从字典中删除指定 shipment_id 的条目。",
        evidenceIds: [cacheId],
      },
      {
        id: "st_rebuild",
        label: "engineering_analysis",
        text: "淘汰后下一次读取需要从当前状态重建快照。",
        evidenceIds: [cacheId],
      },
    ],
    evidence: [cacheId],
    diagram: {
      kind: "component",
      mermaid:
        'flowchart LR\n  n1["snapshot_cache.py"] --> n2["app/screens.py"]',
      nodes: [
        {
          id: "n1",
          label: "snapshot_cache.py",
          evidenceIds: [cacheId],
          status: "observed",
        },
        {
          id: "n2",
          label: "app/screens.py",
          evidenceIds: [cacheId],
          status: "observed",
        },
      ],
      edges: [
        {
          from: "n1",
          to: "n2",
          label: "provides snapshots",
          evidenceIds: [cacheId],
          inferred: false,
        },
      ],
    },
    coverageGaps: [],
  };
}

async function runBuilder(payload: Record<string, unknown>, commitSha: string) {
  const generation = stagedRef({
    generationId: GENERATION_ID,
    repoId: REPO_ID,
    commitSha,
    knowledgeDir: path.join(workDir, "knowledge"),
    jobId: "j_r17_layers0001" as JobId,
    baseContextSha: null,
  });
  const registry = fakeRegistry();
  const dir = scriptDir([lessonEntry(payload)]);
  const result = await buildResearchLessons(
    {
      generation,
      snapshot: fakeSnapshot(
        { [CACHE]: readFixture(CACHE) },
        { commitSha, repoId: REPO_ID },
      ),
      scope: normalizeScope(),
      coverage: coverageFor(commitSha),
      model: scriptedHandle(dir),
      registry,
      external: stubExternal(),
      clock: fixedClock(),
    },
    { claims: claimsPort(commitSha), mermaid: okMermaid() },
  );
  return result;
}

describe("AC-R17-01 — macro and micro lesson layers", () => {
  it("publishes one component map and a code-level layer over the same mechanisms", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const result = await runBuilder(lessonPayload(commitSha), commitSha);

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    const lesson = result.lessons[0];

    // Macro view: a component diagram whose nodes are evidence-bound.
    expect(lesson.diagram.kind).toBe("component");
    expect(lesson.diagram.nodes.length).toBeGreaterThan(0);
    for (const node of lesson.diagram.nodes) {
      expect(node.evidenceIds.length).toBeGreaterThan(0);
    }

    // Micro view: the technical layer names code-level symbols.
    const mechanismIds = (entries: { mechanismId: string }[]) =>
      entries.map((entry) => entry.mechanismId).sort();
    expect(mechanismIds(lesson.plainExplanation)).toEqual(
      mechanismIds(lesson.technicalExplanation),
    );
    expect(new Set(mechanismIds(lesson.plainExplanation)).size).toBe(
      lesson.plainExplanation.length,
    );
    const technical = lesson.technicalExplanation
      .map((entry) => entry.text)
      .join("\n");
    expect(technical).toContain("_entries.pop");
    expect(technical).toContain("SnapshotCache.evict");

    for (const plain of lesson.plainExplanation) {
      const layered = lesson.technicalExplanation.find(
        (entry) => entry.mechanismId === plain.mechanismId,
      )!;
      expect(layered.text).not.toBe(plain.text);
    }

    // One worked example, explicitly labelled.
    expect(lesson.scenario.isExample).toBe(true);
    expect(lesson.scenario.id.length).toBeGreaterThan(0);
  }, 120_000);

  it("rejects a lesson whose plain and technical layers are identical", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const result = await runBuilder(lessonPayload(commitSha, true), commitSha);

    expect(result.lessons).toEqual([]);
    expect(result.blankTeaching).toBe(true);
    const messages = result.failures
      .flatMap((failure) => failure.failures)
      .map((failure) => failure.message);
    expect(
      messages.some((message) => message.includes("same text in both layers")),
    ).toBe(true);
  });
});
