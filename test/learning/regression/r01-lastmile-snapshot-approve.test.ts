/**
 * AC-R01-01: the last-mile lesson must cite all three layers of the fixture —
 * the page that builds `Approve` directly, the mock adapter that approves
 * without re-validating, and the recorded decision log — under the right
 * statement labels.
 *
 * The lesson is produced by the production research builder with a scripted
 * model and the production validators, over the real `last-mile-mini` bytes.
 * A page-only claim cannot borrow the decision label (see the sibling
 * `r01-no-invented-decision`), and every cited id must resolve to a registered
 * source at the generation's commit.
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
const SCREEN = "app/screens.py";
const MOCK = "src/lmp/adapters/mock/server.py";
const DECISION = "docs/decisions/decision-log.md";
const CACHE = "src/lmp/state/snapshot_cache.py";
const REPO_ID = "r_r01_lastmile01" as RepoId;
const GENERATION_ID = "g_r01_lastmile01" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r01-"));
}, 180_000);

afterAll(() => {
  cleanupScripts();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

function readFixture(relPath: string): string {
  return readFileSync(path.join(fixturePath(FIXTURE), relPath), "utf8");
}

function coverageFor(commitSha: string, paths: string[]): CoverageReport {
  const analyzed = paths.map((filePath) => ({
    path: filePath,
    bytes: Buffer.byteLength(readFixture(filePath), "utf8"),
    language: languageOf(filePath),
  }));
  return {
    generationId: GENERATION_ID,
    commitSha,
    complete: true,
    analyzed,
    gaps: [],
    counts: {
      totalFiles: analyzed.length,
      analyzedFiles: analyzed.length,
      excludedFiles: 0,
    },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

/** The three fixture claims the model is allowed to cite. */
function claimsPort(commitSha: string): UpstreamClaimsPort {
  const claim = (page: string, relPath: string) => ({
    id: `c_${page}`,
    statement: `evidence for ${relPath}`,
    evidence: [{ resource: `repo://${relPath}`, version: commitSha }],
  });
  return {
    pages: () => Promise.resolve(["app", "src", "docs"]),
    claimsFor: (_ref, page) => {
      const resource =
        page === "app" ? SCREEN : page === "docs" ? DECISION : MOCK;
      return Promise.resolve([claim(page, resource)]);
    },
    markdown: () => Promise.resolve(""),
  };
}

function lessonPayload(commitSha: string): Record<string, unknown> {
  const screenId = repoSourceId(SCREEN, commitSha, null);
  const mockId = repoSourceId(MOCK, commitSha, null);
  const decisionId = repoSourceId(DECISION, commitSha, null);

  return {
    lessonId: "l_r01_lastmile01",
    scenario: {
      id: "sc_approve_path",
      kind: "library_interface",
      inputs: ["shipment_id"],
      userAction: "读取一个已淘汰快照的审批结果",
      observableResult: "看到页面直接构造的 Approve",
      isExample: true,
    },
    overview: [
      {
        moduleId: "app",
        responsibility: "渲染发货单页面",
        inputs: ["shipment_id"],
        outputs: ["Approve"],
      },
      {
        moduleId: "src",
        responsibility: "提供缓存和 mock 适配器",
        inputs: ["shipment_id"],
        outputs: ["approval snapshot"],
      },
      {
        moduleId: "docs",
        responsibility: "记录审批的决策依据",
        inputs: [],
        outputs: ["D-057", "D-063"],
      },
    ],
    plainExplanation: [
      {
        mechanismId: "m_approve",
        text: "页面在缓存里找不到快照时，直接构造一个满分的 Approve。",
      },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_approve",
        terms: [{ zh: "审批", en: "approval", symbol: "Approve" }],
        text: "app/screens.py 的 render_shipment() 在 snapshot is None 时返回 Approve(shipment_id, score=100)。",
      },
    ],
    choices: [
      {
        decision: "页面直接构造 Approve",
        current: "在页面里完成审批",
        alternatives: [
          {
            option: "回到状态机重新校验",
            whenItFits: "需要保证审批基于当前状态时",
            cost: "页面必须等待一次重新评分",
            evidenceIds: [decisionId],
          },
        ],
        evidenceIds: [screenId],
      },
    ],
    choicesOmittedReason: null,
    boundaries: [
      {
        item: "已淘汰快照的审批不重新校验",
        status: "implemented",
        limits: "这是 demo 服务器的行为",
        evidenceIds: [screenId, mockId],
      },
    ],
    statements: [
      {
        id: "st_page",
        label: "code_fact",
        text: "app/screens.py 在快照被淘汰时直接构造 Approve(shipment_id, score=100)。",
        evidenceIds: [screenId],
      },
      {
        id: "st_mock",
        label: "code_fact",
        text: "src/lmp/adapters/mock/server.py 的 MockApprovalServer.approve() 直接返回 approved。",
        evidenceIds: [mockId],
      },
      {
        id: "st_decision",
        label: "recorded_design_rationale",
        text: "docs/decisions/decision-log.md 记录 D-057 与 D-063 要求在当前状态重新校验并按动作类型分级重评分。",
        evidenceIds: [decisionId],
      },
    ],
    evidence: [screenId, mockId, decisionId],
    diagram: {
      kind: "component",
      mermaid:
        'flowchart LR\n  n1["app/screens.py"] --> n2["src/lmp/adapters/mock/server.py"]',
      nodes: [
        {
          id: "n1",
          label: "app/screens.py",
          evidenceIds: [screenId],
          status: "observed",
        },
        {
          id: "n2",
          label: "src/lmp/adapters/mock/server.py",
          evidenceIds: [mockId],
          status: "observed",
        },
        {
          id: "n3",
          label: "docs/decisions/decision-log.md",
          evidenceIds: [decisionId],
          status: "observed",
        },
      ],
      edges: [
        {
          from: "n1",
          to: "n2",
          label: "页面与 mock 都跳过重新校验",
          evidenceIds: [decisionId],
          inferred: false,
        },
      ],
    },
    coverageGaps: [],
  };
}

async function buildLesson(commitSha: string) {
  const generation = stagedRef({
    generationId: GENERATION_ID,
    repoId: REPO_ID,
    commitSha,
    knowledgeDir: path.join(workDir, "knowledge"),
    jobId: "j_r01_lastmile01" as JobId,
    baseContextSha: null,
  });
  const files = {
    [SCREEN]: readFixture(SCREEN),
    [MOCK]: readFixture(MOCK),
    [DECISION]: readFixture(DECISION),
    [CACHE]: readFixture(CACHE),
  };
  const snapshot = fakeSnapshot(files, { commitSha, repoId: REPO_ID });
  const registry = fakeRegistry();
  const dir = scriptDir([lessonEntry(lessonPayload(commitSha))]);
  const model = scriptedHandle(dir);

  const result = await buildResearchLessons(
    {
      generation,
      snapshot,
      scope: normalizeScope(),
      coverage: coverageFor(commitSha, Object.keys(files)),
      model,
      registry,
      external: stubExternal(),
      clock: fixedClock(),
    },
    { claims: claimsPort(commitSha), mermaid: okMermaid() },
  );
  return { result, registry };
}

describe("AC-R01-01 — three-layer last-mile comparison", () => {
  it("labels the page and mock as code facts and the decision log as recorded rationale", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const { result, registry } = await buildLesson(commitSha);

    expect(result.failures).toEqual([]);
    expect(result.blankTeaching).toBe(false);
    expect(result.lessons).toHaveLength(1);
    const lesson = result.lessons[0];

    const byPath = new Map(
      registry
        .all(GENERATION_ID)
        .filter((ref) => ref.kind === "repo")
        .map((ref) => [ref.kind === "repo" ? ref.path : "", ref.sourceId]),
    );

    const labels = lesson.statements.map((statement) => ({
      label: statement.label,
      evidenceIds: statement.evidenceIds,
    }));
    expect(labels).toContainEqual({
      label: "code_fact",
      evidenceIds: [byPath.get(SCREEN)],
    });
    expect(labels).toContainEqual({
      label: "code_fact",
      evidenceIds: [byPath.get(MOCK)],
    });
    expect(labels).toContainEqual({
      label: "recorded_design_rationale",
      evidenceIds: [byPath.get(DECISION)],
    });

    // Every cited line/path is real at the pinned commit.
    expect(lesson.context.commitSha).toBe(commitSha);
    expect(lesson.evidence).toEqual(
      expect.arrayContaining([
        byPath.get(SCREEN),
        byPath.get(MOCK),
        byPath.get(DECISION),
      ]),
    );
    expect(lesson.checks).toMatchObject({
      structural: "pass",
      evidence: "pass",
      semantic: "pass",
    });
  });
});
