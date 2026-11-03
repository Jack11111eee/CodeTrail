/**
 * AC-R01-02: without a decision source the pipeline must not invent one.
 *
 * Two independent negatives:
 *
 * - the research builder refuses a `recorded_design_rationale` statement whose
 *   evidence is page code only (the lesson is dropped, not published);
 * - a page-only answer that tries to assert an approval decision ends as
 *   `unknown` with `uncited_conclusion`, cites no decision document, and the
 *   model payload never carries the decision-log text it would need.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  CoverageReport,
  GenerationId,
  JobId,
  ModelHandle,
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
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  sourceHit,
  COMMIT_A,
  REPO_ID as QA_REPO_ID,
} from "../qa/qa-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const FIXTURE = "last-mile-mini";
const SCREEN = "app/screens.py";
const MOCK = "src/lmp/adapters/mock/server.py";
const DECISION = "docs/decisions/decision-log.md";
const REPO_ID = "r_r01_noinvent01" as RepoId;
const GENERATION_ID = "g_r01_noinvent01" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r01n-"));
}, 180_000);

afterAll(() => {
  cleanupScripts();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  cleanupTempDirs();
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

function claimsPort(commitSha: string): UpstreamClaimsPort {
  const resourceOf = (page: string): string => (page === "app" ? SCREEN : MOCK);
  return {
    pages: () => Promise.resolve(["app", "src"]),
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

function basePayload(commitSha: string): Record<string, unknown> {
  const screenId = repoSourceId(SCREEN, commitSha, null);
  const mockId = repoSourceId(MOCK, commitSha, null);
  return {
    lessonId: "l_r01_noinvent01",
    scenario: {
      id: "sc_approve_path",
      kind: "library_interface",
      inputs: ["shipment_id"],
      userAction: "读取审批结果",
      observableResult: "页面返回一个 Approve",
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
        responsibility: "提供 mock 适配器",
        inputs: ["shipment_id"],
        outputs: ["approved"],
      },
    ],
    plainExplanation: [
      {
        mechanismId: "m_approve",
        text: "缓存里没有快照时，页面直接构造一个满分审批。",
      },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_approve",
        terms: [{ zh: "审批", en: "approval", symbol: "Approve" }],
        text: "render_shipment() 在 snapshot is None 时返回 Approve(shipment_id, score=100)。",
      },
    ],
    choices: [],
    choicesOmittedReason: "页面只有一条审批路径，没有可比较的替代方案",
    boundaries: [
      {
        item: "页面直接构造审批",
        status: "implemented",
        limits: "只在快照缺失时发生",
        evidenceIds: [screenId],
      },
    ],
    evidence: [screenId, mockId],
    diagram: {
      kind: "component",
      mermaid: 'flowchart LR\n  n1["app/screens.py"] --> n2["mock/server.py"]',
      nodes: [
        {
          id: "n1",
          label: "app/screens.py",
          evidenceIds: [screenId],
          status: "observed",
        },
        {
          id: "n2",
          label: "mock/server.py",
          evidenceIds: [mockId],
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
    jobId: "j_r01_noinvent01" as JobId,
    baseContextSha: null,
  });
  const files = {
    [SCREEN]: readFixture(SCREEN),
    [MOCK]: readFixture(MOCK),
  };
  const registry = fakeRegistry();
  const dir = scriptDir([lessonEntry(payload)]);
  const model = scriptedHandle(dir);
  const result = await buildResearchLessons(
    {
      generation,
      snapshot: fakeSnapshot(files, { commitSha, repoId: REPO_ID }),
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

/** A model that records every payload and always returns `payload`. */
function capturingModel(payload: unknown): {
  model: ModelHandle;
  messages: BaseMessage[][];
} {
  const messages: BaseMessage[][] = [];
  const model: ModelHandle = {
    modelId: "capturing",
    settings: {
      provider: "scripted",
      model: "capturing",
      maxOutputTokens: 1024,
      temperature: 0,
      pricing: null,
      quota: { maxCalls: 10, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    },
    chat: () =>
      ({
        bindTools: () => ({
          invoke: (input: BaseMessage[]) => {
            messages.push(input);
            return Promise.resolve(
              new AIMessage({ content: JSON.stringify(payload) }),
            );
          },
        }),
      }) as never,
    estimate: () => ({ calls: 1, tokens: 0 }),
  };
  return { model, messages };
}

describe("AC-R01-02 — no invented approval decision", () => {
  it("drops a page-only statement that steals the recorded_rationale label", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const payload = basePayload(commitSha);
    payload.statements = [
      {
        id: "st_page",
        label: "code_fact",
        text: "页面直接构造 Approve。",
        evidenceIds: [repoSourceId(SCREEN, commitSha, null)],
      },
      {
        id: "st_fake_decision",
        label: "recorded_design_rationale",
        text: "系统自动批准，并且已经提交 Approve 决策。",
        evidenceIds: [repoSourceId(SCREEN, commitSha, null)],
      },
    ];

    const { result } = await runBuilder(payload, commitSha);

    expect(result.lessons).toEqual([]);
    expect(result.blankTeaching).toBe(true);
    const failures = result.failures.flatMap((failure) => failure.failures);
    expect(
      failures.some(
        (failure) =>
          failure.group === "statements" &&
          failure.message.includes("recorded_design_rationale"),
      ),
    ).toBe(true);
  });

  it("publishes a page-only lesson with zero rationale statements", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const payload = basePayload(commitSha);
    payload.statements = [
      {
        id: "st_page",
        label: "code_fact",
        text: "页面在快照缺失时直接构造 Approve。",
        evidenceIds: [repoSourceId(SCREEN, commitSha, null)],
      },
      {
        id: "st_mock",
        label: "code_fact",
        text: "mock 服务器直接返回 approved。",
        evidenceIds: [repoSourceId(MOCK, commitSha, null)],
      },
    ];

    const { result } = await runBuilder(payload, commitSha);

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    const labels = result.lessons[0].statements.map(
      (statement) => statement.label,
    );
    expect(labels).not.toContain("recorded_design_rationale");
    expect(
      labels.filter((label) => label === "recorded_design_rationale"),
    ).toHaveLength(0);
  });

  it("never grounds a page-only answer in the decision log", async () => {
    const hit = sourceHit(
      "g_r01_answer",
      QA_REPO_ID,
      COMMIT_A,
      SCREEN,
      "snapshot is None 时页面直接构造 Approve",
    );

    const files = { [SCREEN]: readFixture(SCREEN) };
    const { model, messages } = capturingModel({
      answer: "系统自动批准，已提交 Approve 决策。",
      conclusion: "recorded_design_rationale",
      citations: [],
    });
    const harness = createHarness({
      model,
      hits: { g_r01_answer: [hit] },
      filesByGeneration: { g_r01_answer: files },
      generationOfCommit: { [COMMIT_A]: "g_r01_answer" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_r01_answer",
      sources: [{ path: SCREEN }],
      files,
    });

    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "淘汰的旧快照会被自动批准吗？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      const assistant = (await harness.conversations.get(
        conversation.conversationId,
      ))!.messages.find((message) => message.role === "assistant")!;

      // The unsupported conclusion is downgraded, with an explicit reason.
      expect(assistant.status).toBe("failed");
      expect(assistant.unknownReason).toBe("uncited_conclusion");
      expect(assistant.content).toContain("unknown");
      expect(assistant.content).toContain("uncited_conclusion");
      expect(assistant.content).not.toContain("code_fact");
      expect(assistant.citations).toEqual([]);

      // No decision source is available, so the payload cannot contain D-057.
      expect(
        harness.db.repos.sources
          .all(fixture.generationId)
          .some(
            (source) =>
              source.sourceId === repoSourceId(DECISION, COMMIT_A, null),
          ),
      ).toBe(false);
      const promptText = messages
        .flat()
        .map((message) => JSON.stringify(message.content))
        .join("\n");
      expect(promptText).not.toContain("D-057");
      expect(promptText).not.toContain("docs/decisions/decision-log.md");
    } finally {
      harness.db.close();
    }
  });
});
