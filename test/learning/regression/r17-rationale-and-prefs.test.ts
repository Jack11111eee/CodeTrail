/**
 * AC-R17-02: rationale and analysis stay separate, an explainable empty
 * `choices` list publishes, and the learner's background is not a reading
 * position (and neither is an ability score).
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
import { prefsModule } from "../../../src/learning/api/routes/prefs.ts";
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
import { startHarness } from "../helpers/http-client.ts";
import { startRoutesHarness } from "../projects/routes-harness.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const FIXTURE = "last-mile-mini";
const CACHE = "src/lmp/state/snapshot_cache.py";
const DECISION = "docs/decisions/decision-log.md";
const REPO_ID = "r_r17_prefs00001" as RepoId;
const GENERATION_ID = "g_r17_prefs00001" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r17b-"));
}, 180_000);

afterAll(() => {
  cleanupScripts();
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

afterEach(cleanupScripts);

function readFixture(relPath: string): string {
  return readFileSync(path.join(fixturePath(FIXTURE), relPath), "utf8");
}

function coverageFor(commitSha: string): CoverageReport {
  const paths = [CACHE, DECISION];
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
    page === "docs" ? DECISION : CACHE;
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
  options: {
    analysisOnlyDecision?: boolean;
    omitChoicesReason?: boolean;
  } = {},
): Record<string, unknown> {
  const cacheId = repoSourceId(CACHE, commitSha, null);
  const decisionId = repoSourceId(DECISION, commitSha, null);
  return {
    lessonId: "l_r17_prefs00001",
    scenario: {
      id: "sc_evict",
      kind: "library_interface",
      inputs: ["shipment_id"],
      userAction: "读取审批快照",
      observableResult: "淘汰后重建快照",
      isExample: true,
    },
    overview: [
      {
        moduleId: "docs",
        responsibility: "记录审批决策",
        inputs: [],
        outputs: ["D-057", "D-063"],
      },
      {
        moduleId: "src",
        responsibility: "缓存审批快照",
        inputs: ["shipment_id"],
        outputs: ["snapshot"],
      },
    ],
    plainExplanation: [
      { mechanismId: "m_evict", text: "缓存满了就丢掉旧快照。" },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_evict",
        terms: [{ zh: "淘汰", en: "evict", symbol: "evict" }],
        text: "SnapshotCache.evict() 调用 self._entries.pop(shipment_id, None)。",
      },
    ],
    choices: [],
    choicesOmittedReason: options.omitChoicesReason
      ? null
      : "缓存只有字典一种实现，没有可比较的替代方案",
    boundaries: [],
    statements: [
      {
        id: "st_rationale",
        label: "recorded_design_rationale",
        text: "决策日志 D-057 要求在当前状态重新校验审批。",
        evidenceIds: [decisionId],
      },
      {
        id: "st_analysis",
        label: "engineering_analysis",
        text: "淘汰后必须重建快照，避免继续使用旧数据。",
        evidenceIds: options.analysisOnlyDecision
          ? [decisionId]
          : [decisionId, cacheId],
      },
    ],
    evidence: [decisionId, cacheId],
    diagram: {
      kind: "component",
      mermaid: 'flowchart LR\n  n1["snapshot_cache.py"]',
      nodes: [
        {
          id: "n1",
          label: "snapshot_cache.py",
          evidenceIds: [cacheId],
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
    jobId: "j_r17_prefs00001" as JobId,
    baseContextSha: null,
  });
  const files = {
    [CACHE]: readFixture(CACHE),
    [DECISION]: readFixture(DECISION),
  };
  const registry = fakeRegistry();
  const dir = scriptDir([lessonEntry(payload)]);
  const result = await buildResearchLessons(
    {
      generation,
      snapshot: fakeSnapshot(files, { commitSha, repoId: REPO_ID }),
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

describe("AC-R17-02 — rationale, analysis and explainable empties", () => {
  it("keeps recorded rationale and engineering analysis separately labelled", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const result = await runBuilder(lessonPayload(commitSha), commitSha);

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    const statements = result.lessons[0].statements;
    const rationale = statements.find((entry) => entry.id === "st_rationale")!;
    const analysis = statements.find((entry) => entry.id === "st_analysis")!;

    expect(rationale.label).toBe("recorded_design_rationale");
    expect(analysis.label).toBe("engineering_analysis");
    expect(rationale.label).not.toBe(analysis.label);
    expect(rationale.evidenceIds).toEqual([
      repoSourceId(DECISION, commitSha, null),
    ]);
    expect(analysis.evidenceIds).toEqual([
      repoSourceId(DECISION, commitSha, null),
      repoSourceId(CACHE, commitSha, null),
    ]);
  });

  it("rejects analysis that cites only a decision document", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const result = await runBuilder(
      lessonPayload(commitSha, { analysisOnlyDecision: true }),
      commitSha,
    );

    expect(result.lessons).toEqual([]);
    expect(
      result.failures
        .flatMap((failure) => failure.failures)
        .some((failure) =>
          failure.message.includes("may not cite only a decision document"),
        ),
    ).toBe(true);
  });

  it("publishes choices=[] with a reason and rejects it without one", async () => {
    const commitSha = fixtureSha(FIXTURE, "HEAD");
    const withReason = await runBuilder(lessonPayload(commitSha), commitSha);
    expect(withReason.lessons).toHaveLength(1);
    expect(withReason.lessons[0].choices).toEqual([]);
    expect(withReason.lessons[0].choicesOmittedReason).toContain("没有可比较");

    const withoutReason = await runBuilder(
      lessonPayload(commitSha, { omitChoicesReason: true }),
      commitSha,
    );
    expect(withoutReason.lessons).toEqual([]);
    expect(
      withoutReason.failures
        .flatMap((failure) => failure.failures)
        .some((failure) =>
          failure.message.includes("required when choices is empty"),
        ),
    ).toBe(true);
  });
});

describe("AC-R17-02 — background and reading position are independent", () => {
  it("writes them to different tables and never exposes an ability score", async () => {
    const server = await startRoutesHarness({ extraModules: [prefsModule] });
    const harness = await startHarness({ baseUrl: server.url });
    try {
      const preferenceOnly = await harness.request("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          explainLevel: "technical_first",
          background: "熟悉 TypeScript，不熟悉 Python。",
        }),
      });
      expect(preferenceOnly.status).toBe(200);

      // Background lands in the preference table and nothing in the reader
      // position table.
      const preferences = server.db.raw
        .prepare("SELECT key FROM learner_preferences ORDER BY key")
        .all() as { key: string }[];
      expect(preferences.map((row) => row.key)).toEqual([
        "background",
        "explain_level",
      ]);
      const positionsAfterPreference = server.db.raw
        .prepare("SELECT COUNT(*) AS count FROM reading_positions")
        .get() as { count: number };
      expect(positionsAfterPreference.count).toBe(0);

      const positionOnly = await harness.request("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          readingPosition: {
            generationId: "g_reader_1",
            lessonId: "l_reader_1",
            offset: 137,
          },
        }),
      });
      expect(positionOnly.status).toBe(200);

      // A reading position lands in `reading_positions` only, and carries an
      // offset — not a score, not a skill estimate.
      const positions = server.db.raw
        .prepare(
          "SELECT generation_id, lesson_id, offset FROM reading_positions",
        )
        .all() as {
        generation_id: string;
        lesson_id: string;
        offset: number;
      }[];
      expect(positions).toEqual([
        {
          generation_id: "g_reader_1",
          lesson_id: "l_reader_1",
          offset: 137,
        },
      ]);
      const preferenceKeysAfter = server.db.raw
        .prepare("SELECT key FROM learner_preferences ORDER BY key")
        .all() as { key: string }[];
      expect(preferenceKeysAfter.map((row) => row.key)).toEqual([
        "background",
        "explain_level",
      ]);

      // The two tables have no overlapping column, and neither has a score.
      const preferenceColumns = (
        server.db.raw
          .prepare("PRAGMA table_info(learner_preferences)")
          .all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      const positionColumns = (
        server.db.raw.prepare("PRAGMA table_info(reading_positions)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      expect(preferenceColumns).toContain("key");
      expect(positionColumns).toContain("offset");
      expect(positionColumns).not.toContain("background");
      expect(preferenceColumns).not.toContain("offset");
      for (const column of [...preferenceColumns, ...positionColumns]) {
        expect(column).not.toMatch(/score|mastery|proficiency|ability/iu);
      }

      const read = await harness.request("/api/preferences");
      expect(read.status).toBe(200);
      const body = read.json as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "preferences",
        "readingPositions",
      ]);
      const serialized = JSON.stringify(body).toLowerCase();
      for (const banned of [
        "mastery",
        "proficiency",
        "abilityscore",
        "examscore",
      ]) {
        expect(serialized).not.toContain(banned);
      }
      expect((body.preferences as Record<string, unknown>).background).toBe(
        "熟悉 TypeScript，不熟悉 Python。",
      );
    } finally {
      await harness.close();
      await server.close();
    }
  }, 120_000);

  it("keeps both stores independent for one payload and upserts the reading position", async () => {
    const server = await startRoutesHarness({ extraModules: [prefsModule] });
    const harness = await startHarness({ baseUrl: server.url });
    try {
      const combined = await harness.request("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          explainLevel: "plain_first",
          background: "熟悉 Python，不熟悉 Rust。",
          readingPosition: {
            generationId: "g_reader_2",
            lessonId: "l_reader_2",
            offset: 5,
          },
        }),
      });
      expect(combined.status).toBe(200);

      // One request, two stores: each field landed in its own table.
      expect(
        server.db.raw
          .prepare("SELECT key, value FROM learner_preferences ORDER BY key")
          .all(),
      ).toEqual([
        {
          key: "background",
          value: JSON.stringify("熟悉 Python，不熟悉 Rust。"),
        },
        { key: "explain_level", value: JSON.stringify("plain_first") },
      ]);
      expect(
        server.db.raw
          .prepare(
            "SELECT generation_id, lesson_id, offset FROM reading_positions",
          )
          .all(),
      ).toEqual([
        { generation_id: "g_reader_2", lesson_id: "l_reader_2", offset: 5 },
      ]);

      // The same reader position moves by upsert; it does not accumulate rows.
      const moved = await harness.request("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          readingPosition: {
            generationId: "g_reader_2",
            lessonId: "l_reader_2",
            offset: 88,
          },
        }),
      });
      expect(moved.status).toBe(200);
      expect(
        server.db.raw
          .prepare(
            "SELECT generation_id, lesson_id, offset FROM reading_positions",
          )
          .all(),
      ).toEqual([
        { generation_id: "g_reader_2", lesson_id: "l_reader_2", offset: 88 },
      ]);
      // Moving the reading position did not rewrite the learner preferences.
      expect(
        server.db.raw
          .prepare("SELECT COUNT(*) AS count FROM learner_preferences")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      await harness.close();
      await server.close();
    }
  }, 120_000);

  it("rejects a malformed body without writing either table", async () => {
    const server = await startRoutesHarness({ extraModules: [prefsModule] });
    const harness = await startHarness({ baseUrl: server.url });
    try {
      const response = await harness.request("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ background: "not an object" }]),
      });

      expect(response.status).toBe(400);
      expect(
        (response.json as { error?: { code?: string } }).error?.code,
      ).toBe("invalid_input");
      expect(
        server.db.raw
          .prepare("SELECT COUNT(*) AS count FROM learner_preferences")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        server.db.raw
          .prepare("SELECT COUNT(*) AS count FROM reading_positions")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      await harness.close();
      await server.close();
    }
  }, 120_000);
});
