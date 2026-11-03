/**
 * AC-R07-01: a feature that exists only in a design note is `planned`.
 *
 * The lesson keeps the unimplemented upload feature at `planned` backed by the
 * design note, and `validateStructural` refuses to promote it to `implemented`
 * on planned-only evidence. A claim with no evidence is downgraded to
 * `unknown` with a reason at answer time.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  scriptDir as qaScriptDir,
  sourceHit,
  COMMIT_A,
  REPO_ID as QA_REPO_ID,
} from "../qa/qa-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const FIXTURE = "planned-vs-implemented";
const DESIGN = "docs/design/future_upload.md";
const NOTES = "src/app/notes.py";
const REPO_ID = "r_r07_planned001" as RepoId;
const GENERATION_ID = "g_r07_planned001" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r07-"));
}, 180_000);

afterAll(() => {
  cleanupScripts();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

afterEach(cleanupTempDirs);

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

function claimsPort(commitSha: string): UpstreamClaimsPort {
  const resourceOf = (page: string): string =>
    page === "docs" ? DESIGN : NOTES;
  return {
    pages: () => Promise.resolve(["docs", "src"]),
    claimsFor: (_ref, page) =>
      Promise.resolve([
        {
          id: `c_${page}`,
          statement: `evidence for ${resourceOf(page)}`,
          evidence: [
            { resource: `repo://${resourceOf(page)}`, version: commitSha },
          ],
        },
      ]),
    markdown: () => Promise.resolve(""),
  };
}

function lessonPayload(
  commitSha: string,
  uploadStatus: "planned" | "implemented",
): Record<string, unknown> {
  const designId = repoSourceId(DESIGN, commitSha, null);
  const notesId = repoSourceId(NOTES, commitSha, null);
  return {
    lessonId: "l_r07_planned001",
    scenario: {
      id: "sc_notes",
      kind: "library_interface",
      inputs: ["store", "text"],
      userAction: "添加并列出笔记",
      observableResult: "返回排序后的笔记标题",
      isExample: true,
    },
    overview: [
      {
        moduleId: "docs",
        responsibility: "记录尚未实现的上传设计",
        inputs: [],
        outputs: ["future_upload.md"],
      },
      {
        moduleId: "src",
        responsibility: "提供笔记读写辅助函数",
        inputs: ["store"],
        outputs: ["notes"],
      },
    ],
    plainExplanation: [
      {
        mechanismId: "m_notes",
        text: "笔记只存在内存字典里，按标题排序后返回。",
      },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_notes",
        terms: [{ zh: "笔记", en: "note", symbol: "list_notes" }],
        text: "src/app/notes.py 的 list_notes(store) 返回 sorted(store)。",
      },
    ],
    choices: [],
    choicesOmittedReason: "仓库里只有一种笔记实现，没有可比较的替代方案",
    boundaries: [
      {
        item: "PDF 上传功能",
        status: uploadStatus,
        limits: "设计文档明确说明尚未实现",
        evidenceIds: [designId],
      },
      {
        item: "纯文本笔记",
        status: "implemented",
        limits: "只存在内存字典中",
        evidenceIds: [notesId],
      },
    ],
    statements: [
      {
        id: "st_plan",
        label: "recorded_design_rationale",
        text: "docs/design/future_upload.md 记录 PDF 上传仍处于计划阶段。",
        evidenceIds: [designId],
      },
      {
        id: "st_notes",
        label: "code_fact",
        text: "src/app/notes.py 提供 list_notes 与 add_note。",
        evidenceIds: [notesId],
      },
    ],
    evidence: [designId, notesId],
    diagram: {
      kind: "component",
      mermaid:
        'flowchart LR\n  n1["docs/design/future_upload.md"]\n  n2["src/app/notes.py"]',
      nodes: [
        {
          id: "n1",
          label: "PDF 上传（计划中）",
          evidenceIds: [],
          status: "planned",
        },
        {
          id: "n2",
          label: "src/app/notes.py",
          evidenceIds: [notesId],
          status: "observed",
        },
      ],
      edges: [],
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
    jobId: "j_r07_planned001" as JobId,
    baseContextSha: null,
  });
  const files = { [DESIGN]: readFixture(DESIGN), [NOTES]: readFixture(NOTES) };
  const registry = fakeRegistry();
  const dir = scriptDir([lessonEntry(payload)]);
  const result = await buildResearchLessons(
    {
      generation,
      snapshot: fakeSnapshot(files, { commitSha, repoId: REPO_ID }),
      scope: normalizeScope(),
      coverage: coverageFor(commitSha, Object.keys(files)),
      model: scriptedHandle(dir),
      registry,
      external: stubExternal(),
      clock: fixedClock(),
    },
    { claims: claimsPort(commitSha), mermaid: okMermaid() },
  );
  return { result, registry };
}

describe("AC-R07-01 — planned versus implemented", () => {
  it("publishes the planned feature as planned and the note helper as implemented", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const { result } = await runBuilder(
      lessonPayload(commitSha, "planned"),
      commitSha,
    );

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    const upload = result.lessons[0].boundaries.find(
      (boundary) => boundary.item === "PDF 上传功能",
    )!;
    const notes = result.lessons[0].boundaries.find(
      (boundary) => boundary.item === "纯文本笔记",
    )!;

    expect(upload.status).toBe("planned");
    expect(upload.evidenceIds).toEqual([repoSourceId(DESIGN, commitSha, null)]);
    expect(notes.status).toBe("implemented");
    expect(notes.evidenceIds).toEqual([repoSourceId(NOTES, commitSha, null)]);
    expect(
      result.lessons[0].boundaries.some(
        (boundary) =>
          boundary.item === "PDF 上传功能" && boundary.status === "implemented",
      ),
    ).toBe(false);
  });

  it("refuses to label the planned feature implemented on design evidence only", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const { result } = await runBuilder(
      lessonPayload(commitSha, "implemented"),
      commitSha,
    );

    expect(result.lessons).toEqual([]);
    expect(result.blankTeaching).toBe(true);
    const messages = result.failures
      .flatMap((failure) => failure.failures)
      .map((failure) => failure.message);
    expect(
      messages.some((message) =>
        message.includes("implemented boundary has only design-doc evidence"),
      ),
    ).toBe(true);
    expect(messages.some((message) => message.includes("downgrade"))).toBe(
      true,
    );
  });
});

describe("AC-R07-01 — unsupported claims become unknown", () => {
  it("downgrades an uncited implementation claim with a reason", async () => {
    const designSource = repoSourceId(DESIGN, COMMIT_A, null);
    const hit = sourceHit(
      "g_r07_answer",
      QA_REPO_ID,
      COMMIT_A,
      DESIGN,
      "Status: planned, not implemented.",
    );
    const files = { [DESIGN]: readFixture(DESIGN) };
    const harness = createHarness({
      modelDir: qaScriptDir([
        answerEntry({
          answer: "PDF 上传接口已经实现。",
          conclusion: "code_fact",
          citations: [],
        }),
      ]),
      hits: { g_r07_answer: [hit] },
      filesByGeneration: { g_r07_answer: files },
      generationOfCommit: { [COMMIT_A]: "g_r07_answer" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_r07_answer",
      sources: [{ path: DESIGN }],
      files,
    });

    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "PDF 上传功能实现了吗？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      const assistant = (await harness.conversations.get(
        conversation.conversationId,
      ))!.messages.find((message) => message.role === "assistant")!;

      expect(assistant.status).toBe("failed");
      expect(assistant.unknownReason).toBe("uncited_conclusion");
      expect(assistant.content).toContain("unknown");
      expect(assistant.content).toContain("uncited_conclusion");
      expect(assistant.citations).toEqual([]);
      expect(designSource).toBe(repoSourceId(DESIGN, COMMIT_A, null));
    } finally {
      harness.db.close();
    }
  });
});
