/**
 * AC-R03-02: after a rename the new lesson cites the new path, the old path
 * is unavailable at the new commit, and the old commit still returns its own
 * (old) content — never the new file posing as the old one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ChangeLesson,
  ChangeRecord,
  DiffResult,
  GenerationId,
  JobId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import {
  LearningError,
  stagedRef,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { buildChangeLesson } from "../../../src/learning/lessons/builder.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
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
const FIXTURE = "evolution";
const OLD_PATH = "src/inventory.ts";
const NEW_PATH = "src/stock.ts";
const CALLER = "src/checkout.ts";
const REPO_ID = "r_r03_renamed0001" as RepoId;
const GENERATION_ID = "g_r03_renamed0001" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r03b-"));
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

function changeEvent(headSha: string, baseSha: string): ChangeRecord {
  return {
    eventId: "e_r03_renamed0001",
    eventKey: "commit-r03b",
    repoId: REPO_ID,
    projectId: "p_r03_renamed0001",
    streamId: "main",
    streamKind: "default_branch",
    kind: "commit",
    baseSha,
    headSha,
    mergeBaseSha: baseSha,
    baseContextSha: baseSha,
    significance: "full",
    state: "discovered",
    jobId: null,
    gapReason: null,
    linkedEventId: null,
    linkRelation: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    publishedAt: null,
    payload: { commit: { firstParent: baseSha, associatedCommits: [] } },
  } as unknown as ChangeRecord;
}

describe("AC-R03-02 — renamed module", () => {
  it("cites the new path, leaves the old path unavailable and keeps old content old", async () => {
    const baseSha = fixtureSha(FIXTURE, "HEAD~1");
    const headSha = fixtureSha(FIXTURE, "HEAD");
    const baseFiles = {
      [OLD_PATH]: readAt(baseSha, OLD_PATH),
      [CALLER]: readAt(baseSha, CALLER),
    };
    const headFiles = {
      [NEW_PATH]: readAt(headSha, NEW_PATH),
      [CALLER]: readAt(headSha, CALLER),
    };
    const headStock = repoSourceId(NEW_PATH, headSha, null);
    const diff: DiffResult = {
      entries: [
        { path: NEW_PATH, status: "R", oldPath: OLD_PATH },
        { path: CALLER, status: "M" },
      ],
      truncated: false,
      gaps: [],
    };

    const payload = {
      lessonId: "l_r03_renamed0001",
      scenario: {
        id: "sc_rename",
        kind: "library_interface",
        inputs: ["item"],
        userAction: "读取库存字段",
        observableResult: "从 copies 变成 quantity",
        isExample: true,
      },
      overview: [
        {
          moduleId: "src",
          responsibility: "库存模型与结算调用方",
          inputs: ["item"],
          outputs: ["stock level"],
        },
      ],
      plainExplanation: [
        {
          mechanismId: "m_rename",
          text: "库存模块改名，旧的 inventory.ts 不再存在。",
        },
      ],
      technicalExplanation: [
        {
          mechanismId: "m_rename",
          terms: [{ zh: "库存", en: "inventory", symbol: "quantity" }],
          text: "src/stock.ts 导出 quantity 字段，src/checkout.ts 从 ./stock.js 导入。",
        },
      ],
      choices: [],
      choicesOmittedReason: "这次只做文件改名，没有可比较的替代设计",
      boundaries: [
        {
          item: "旧文件 inventory.ts 已改名",
          status: "implemented",
          limits: "新版本不再有 src/inventory.ts",
          evidenceIds: [headStock],
        },
      ],
      statements: [
        {
          id: "st_new_path",
          label: "code_fact",
          text: "B 版本的 src/stock.ts 使用 quantity 字段。",
          evidenceIds: [headStock],
        },
      ],
      evidence: [headStock],
      diagram: {
        kind: "timeline",
        mermaid: "timeline\n  section 版本\n  inventory.ts : stock.ts",
        nodes: [
          {
            id: "n1",
            label: "stock.ts (B)",
            evidenceIds: [headStock],
            status: "observed",
          },
        ],
        edges: [],
      },
      coverageGaps: [],
      behaviorChange: {
        before: "src/inventory.ts",
        after: "src/stock.ts",
      },
      affectedModules: [
        { moduleId: "src", effect: "inventory.ts 改名为 stock.ts" },
      ],
      keyTechnologies: ["TypeScript"],
      alternatives: [],
      unverifiedEffects: [],
      omittedReasons: {
        alternatives: "文件改名没有可比较的替代方案",
        unverifiedEffects: "没有观察到未验证的影响",
      },
    };

    const registry = fakeRegistry();
    const generation = stagedRef({
      generationId: GENERATION_ID,
      repoId: REPO_ID,
      commitSha: headSha,
      knowledgeDir: path.join(workDir, "knowledge"),
      jobId: "j_r03_renamed0001" as JobId,
      baseContextSha: baseSha,
    });
    const baseSnapshot = fakeSnapshot(baseFiles, {
      commitSha: baseSha,
      repoId: REPO_ID,
    });
    const headSnapshot = fakeSnapshot(headFiles, {
      commitSha: headSha,
      repoId: REPO_ID,
    });

    const result = await buildChangeLesson(
      {
        generation,
        event: changeEvent(headSha, baseSha),
        diff,
        baseSnapshot,
        headSnapshot,
        scope: normalizeScope(),
        model: scriptedHandle(scriptDir([lessonEntry(payload)])),
        registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { mermaid: okMermaid() },
    );

    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    const lesson: ChangeLesson = result.lessons[0] as ChangeLesson;
    expect(lesson.kind).toBe("change");

    // The new lesson cites the new path.
    expect(lesson.evidence).toContain(headStock);
    expect(
      registry
        .all(GENERATION_ID)
        .some((ref) => ref.kind === "repo" && ref.path === NEW_PATH),
    ).toBe(true);

    // The old path does not exist at the new commit: it is unavailable, not
    // silently redirected to the new file.
    expect(headFiles[OLD_PATH]).toBeUndefined();
    await expect(headSnapshot.exists(OLD_PATH)).resolves.toBe(false);
    expect(() => headSnapshot.read(OLD_PATH)).toThrow(LearningError);
    expect(
      registry
        .all(GENERATION_ID)
        .some(
          (ref) =>
            ref.kind === "repo" &&
            ref.path === OLD_PATH &&
            ref.commitSha === headSha,
        ),
    ).toBe(false);

    // The old commit still serves the old content (and only the old content).
    const oldRef = repoSourceId(OLD_PATH, baseSha, null);
    await expect(baseSnapshot.read(OLD_PATH)).resolves.toContain("copies");
    await expect(baseSnapshot.read(OLD_PATH)).resolves.not.toContain(
      "quantity",
    );
    expect(oldRef).not.toBe(headStock);
    expect(lesson.behaviorChange.before).toContain("inventory.ts");
    expect(lesson.behaviorChange.after).toContain("stock.ts");
  }, 120_000);
});
