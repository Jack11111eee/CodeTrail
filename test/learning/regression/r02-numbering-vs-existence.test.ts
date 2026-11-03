/**
 * AC-R02-01: format validation and existence validation are different facts.
 *
 * `schemas/ids.py` proves an identifier *matches the pattern*; only
 * `service/orders.py` can prove an order *exists*. The lesson must carry them
 * as two independent citations (never one source standing in for both), and a
 * page reading both files must cite both.
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

const FIXTURE = "numbering-schema";
const IDS = "schemas/ids.py";
const ORDERS = "service/orders.py";
const REPO_ID = "r_r02_numbering01" as RepoId;
const GENERATION_ID = "g_r02_numbering01" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r02-"));
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

function claimsPort(commitSha: string, paths: string[]): UpstreamClaimsPort {
  return {
    pages: () => Promise.resolve(["schemas", "service"]),
    claimsFor: (_ref, page) => {
      const resource = page === "schemas" ? paths[0] : (paths[1] ?? paths[0]);
      return Promise.resolve([
        {
          id: `c_${page}`,
          statement: `evidence for ${resource}`,
          evidence: [{ resource: `repo://${resource}`, version: commitSha }],
        },
      ]);
    },
    markdown: () => Promise.resolve(""),
  };
}

function lessonPayload(commitSha: string): Record<string, unknown> {
  const idsId = repoSourceId(IDS, commitSha, null);
  const ordersId = repoSourceId(ORDERS, commitSha, null);
  return {
    lessonId: "l_r02_numbering01",
    scenario: {
      id: "sc_load_order",
      kind: "library_interface",
      inputs: ["order_id"],
      userAction: "用 ord_000042 调用 load_order",
      observableResult: "格式合法但查询不到订单",
      isExample: true,
    },
    overview: [
      {
        moduleId: "schemas",
        responsibility: "定义标识符格式",
        inputs: ["value"],
        outputs: ["bool"],
      },
      {
        moduleId: "service",
        responsibility: "按 id 读取订单",
        inputs: ["order_id"],
        outputs: ["order"],
      },
    ],
    plainExplanation: [
      {
        mechanismId: "m_format",
        text: "先检查编号的格式，格式对不代表订单存在。",
      },
      {
        mechanismId: "m_existence",
        text: "真正读取订单时，存储里没有这个编号就会失败。",
      },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_format",
        terms: [
          { zh: "格式校验", en: "format validation", symbol: "ORDER_ID" },
        ],
        text: "schemas/ids.py 用正则 ^ord_[0-9]{6}$ 判断格式。",
      },
      {
        mechanismId: "m_existence",
        terms: [{ zh: "存在性", en: "existence", symbol: "store[order_id]" }],
        text: "service/orders.py 的 load_order() 在格式通过后直接读取 store[order_id]。",
      },
    ],
    choices: [],
    choicesOmittedReason: "两层校验都由现有代码决定，没有可比较的替代设计",
    boundaries: [
      {
        item: "MISSING_ORDER_ID 格式合法但不存在",
        status: "implemented",
        limits: "load_missing_order() 会抛出 KeyError",
        evidenceIds: [idsId, ordersId],
      },
    ],
    statements: [
      {
        id: "st_format",
        label: "code_fact",
        text: "schemas/ids.py 只证明 ord_000042 匹配 ^ord_[0-9]{6}$。",
        evidenceIds: [idsId],
      },
      {
        id: "st_existence",
        label: "code_fact",
        text: "service/orders.py 证明 ord_000042 从未被持久化，读取会失败。",
        evidenceIds: [ordersId],
      },
    ],
    evidence: [idsId, ordersId],
    diagram: {
      kind: "component",
      mermaid:
        'flowchart LR\n  n1["schemas/ids.py"] --> n2["service/orders.py"]',
      nodes: [
        {
          id: "n1",
          label: "schemas/ids.py",
          evidenceIds: [idsId],
          status: "observed",
        },
        {
          id: "n2",
          label: "service/orders.py",
          evidenceIds: [ordersId],
          status: "observed",
        },
      ],
      edges: [
        {
          from: "n1",
          to: "n2",
          label: "格式通过后仍需查存在性",
          evidenceIds: [ordersId],
          inferred: false,
        },
      ],
    },
    coverageGaps: [],
  };
}

async function runBuilder(
  payload: Record<string, unknown>,
  commitSha: string,
  paths: string[],
) {
  const generation = stagedRef({
    generationId: GENERATION_ID,
    repoId: REPO_ID,
    commitSha,
    knowledgeDir: path.join(workDir, "knowledge"),
    jobId: "j_r02_numbering01" as JobId,
    baseContextSha: null,
  });
  const files = Object.fromEntries(
    paths.map((relPath) => [relPath, readFixture(relPath)]),
  );
  const registry = fakeRegistry();
  const dir = scriptDir([lessonEntry(payload)]);
  const result = await buildResearchLessons(
    {
      generation,
      snapshot: fakeSnapshot(files, { commitSha, repoId: REPO_ID }),
      scope: normalizeScope(),
      coverage: coverageFor(commitSha, paths),
      model: scriptedHandle(dir),
      registry,
      external: stubExternal(),
      clock: fixedClock(),
    },
    { claims: claimsPort(commitSha, paths), mermaid: okMermaid() },
  );
  return { result, registry };
}

describe("AC-R02-01 — format versus existence", () => {
  it("keeps the format regex and the existence check on independent sources", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const { result } = await runBuilder(lessonPayload(commitSha), commitSha, [
      IDS,
      ORDERS,
    ]);

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    const statements = result.lessons[0].statements;
    const format = statements.find((entry) => entry.id === "st_format")!;
    const existence = statements.find((entry) => entry.id === "st_existence")!;

    expect(format.evidenceIds).toEqual([repoSourceId(IDS, commitSha, null)]);
    expect(existence.evidenceIds).toEqual([
      repoSourceId(ORDERS, commitSha, null),
    ]);
    expect(format.evidenceIds).not.toEqual(existence.evidenceIds);
    expect(
      statements.some(
        (entry) =>
          entry.evidenceIds.includes(repoSourceId(IDS, commitSha, null)) &&
          entry.evidenceIds.includes(repoSourceId(ORDERS, commitSha, null)),
      ),
    ).toBe(false);
  });

  it("drops the lesson when the existence source is missing", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    // Only the schema file is registered, while the lesson still cites the
    // service file: the builder must not accept an unregistered id.
    const { result } = await runBuilder(lessonPayload(commitSha), commitSha, [
      IDS,
    ]);

    expect(result.lessons).toEqual([]);
    expect(result.blankTeaching).toBe(true);
    const failures = result.failures.flatMap((failure) => failure.failures);
    expect(
      failures.some((failure) =>
        failure.message.includes("not registered to this generation"),
      ),
    ).toBe(true);
  });
});

describe("AC-R02-01 — the answer cites both evidence paths", () => {
  it("returns two citations from two different files", async () => {
    const idsHit = sourceHit(
      "g_r02_answer",
      QA_REPO_ID,
      COMMIT_A,
      IDS,
      'ORDER_ID = re.compile(r"^ord_[0-9]{6}$")',
      { start: 6, end: 6 },
    );
    const ordersHit = sourceHit(
      "g_r02_answer",
      QA_REPO_ID,
      COMMIT_A,
      ORDERS,
      'MISSING_ORDER_ID = "ord_000042"',
      { start: 7, end: 7 },
    );
    const idsSource = repoSourceId(IDS, COMMIT_A, { start: 6, end: 6 });
    const ordersSource = repoSourceId(ORDERS, COMMIT_A, { start: 7, end: 7 });

    const files = { [IDS]: readFixture(IDS), [ORDERS]: readFixture(ORDERS) };
    const harness = createHarness({
      modelDir: qaScriptDir([
        answerEntry({
          answer: "ord_000042 格式合法，但存储中没有这条订单，所以读取会失败。",
          conclusion: "code_fact",
          citations: [{ sourceId: idsSource }, { sourceId: ordersSource }],
        }),
      ]),
      hits: { g_r02_answer: [idsHit, ordersHit] },
      filesByGeneration: { g_r02_answer: files },
      generationOfCommit: { [COMMIT_A]: "g_r02_answer" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_r02_answer",
      sources: [
        { path: IDS, lines: { start: 6, end: 6 } },
        { path: ORDERS, lines: { start: 7, end: 7 } },
      ],
      files,
    });

    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "ord_000042 存在吗？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      const assistant = (await harness.conversations.get(
        conversation.conversationId,
      ))!.messages.find((message) => message.role === "assistant")!;

      expect(assistant.status).toBe("complete");
      expect(
        assistant.citations.map((citation) => citation.sourceId).sort(),
      ).toEqual([idsSource, ordersSource].sort());
      expect(assistant.citations.map((citation) => citation.commitSha)).toEqual(
        [COMMIT_A, COMMIT_A],
      );
      expect(
        new Set(assistant.citations.map((citation) => citation.label)).size,
      ).toBeGreaterThan(1);
    } finally {
      harness.db.close();
    }
  });
});
