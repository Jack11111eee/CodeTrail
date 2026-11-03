/**
 * AC-R03-01: the `evolution` B commit yields a change record with affected
 * modules and call sites, and every cited line still exists at the new commit.
 * A lesson that cites a path only present in the old version is rejected, so a
 * dependent lesson cannot silently keep pointing at the past.
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
import { stagedRef } from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { buildChangeLesson } from "../../../src/learning/lessons/builder.ts";
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
  scriptedHandle,
  scriptDir,
  stubExternal,
} from "../helpers/lesson-context.ts";
import { emptyCoverage } from "../helpers/lesson-sample.ts";
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
const REPO_ID = "r_r03_callsite001" as RepoId;
const GENERATION_ID = "g_r03_callsite001" as GenerationId;

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
  workDir = mkdtempSync(path.join(os.tmpdir(), "codetrail-r03a-"));
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
    eventId: "e_r03_callsite0001",
    eventKey: "commit-r03",
    repoId: REPO_ID,
    projectId: "p_r03_callsite001",
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

describe("AC-R03-01 — change record, call sites and new-version lines", () => {
  it("lists affected modules and call sites whose evidence still exists at head", async () => {
    const baseSha = fixtureSha(FIXTURE, "HEAD~1");
    const headSha = fixtureSha(FIXTURE, "HEAD");
    const baseFiles: Record<string, string> = {
      [OLD_PATH]: readAt(baseSha, OLD_PATH),
      [CALLER]: readAt(baseSha, CALLER),
    };
    const headFiles: Record<string, string> = {
      [NEW_PATH]: readAt(headSha, NEW_PATH),
      [CALLER]: readAt(headSha, CALLER),
    };

    const headStock = repoSourceId(NEW_PATH, headSha, null);
    const headCaller = repoSourceId(CALLER, headSha, null);
    const diff: DiffResult = {
      entries: [
        { path: NEW_PATH, status: "R", oldPath: OLD_PATH },
        { path: CALLER, status: "M" },
      ],
      truncated: false,
      gaps: [],
    };

    const payload = {
      lessonId: "l_r03_callsite0001",
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
          text: "库存字段改名，调用方也跟着换到新模块。",
        },
      ],
      technicalExplanation: [
        {
          mechanismId: "m_rename",
          terms: [{ zh: "库存", en: "inventory", symbol: "quantity" }],
          text: "stockLevel() 现在读取 item.quantity，checkout 从 ./stock.js 导入。",
        },
      ],
      choices: [],
      choicesOmittedReason: "这次只做字段与文件重命名，没有可比较的替代设计",
      boundaries: [
        {
          item: "旧字段 legacySku 已删除",
          status: "implemented",
          limits: "旧字段不再存在于新版本",
          evidenceIds: [headStock],
        },
      ],
      statements: [
        {
          id: "st_after",
          label: "code_fact",
          text: "B 版本的 stock.ts 使用 quantity 字段。",
          evidenceIds: [headStock],
        },
        {
          id: "st_call_site",
          label: "code_fact",
          text: "src/checkout.ts 从 ./stock.js 导入 stockLevel。",
          evidenceIds: [headCaller],
        },
      ],
      evidence: [headStock, headCaller],
      diagram: {
        kind: "timeline",
        mermaid: "timeline\n  section 版本\n  copies : quantity",
        nodes: [
          {
            id: "n1",
            label: "stock.ts (B)",
            evidenceIds: [headStock],
            status: "observed",
          },
          {
            id: "n2",
            label: "checkout.ts (B)",
            evidenceIds: [headCaller],
            status: "observed",
          },
        ],
        edges: [],
      },
      coverageGaps: [],
      behaviorChange: {
        before: "InventoryItem.copies 与 inventory.ts",
        after: "InventoryItem.quantity 与 stock.ts",
      },
      affectedModules: [
        {
          moduleId: "src",
          effect: "库存字段改名，checkout 调用方切换到 stock.ts",
        },
      ],
      keyTechnologies: ["TypeScript"],
      alternatives: [],
      unverifiedEffects: [],
      omittedReasons: {
        alternatives: "重命名没有可比较的替代方案",
        unverifiedEffects: "没有观察到未验证的影响",
      },
    };

    const registry = fakeRegistry();
    const generation = stagedRef({
      generationId: GENERATION_ID,
      repoId: REPO_ID,
      commitSha: headSha,
      knowledgeDir: path.join(workDir, "knowledge"),
      jobId: "j_r03_callsite0001" as JobId,
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

    // The six record fields, with a module and an explicit call-site effect.
    expect(lesson.behaviorChange).toEqual({
      before: "InventoryItem.copies 与 inventory.ts",
      after: "InventoryItem.quantity 与 stock.ts",
    });
    expect(lesson.affectedModules).toEqual([
      {
        moduleId: "src",
        effect: "库存字段改名，checkout 调用方切换到 stock.ts",
      },
    ]);
    expect(
      lesson.affectedModules.map((module) => module.effect).join("\n"),
    ).toContain("checkout");
    expect(lesson.checks).toMatchObject({
      structural: "pass",
      evidence: "pass",
      semantic: "pass",
    });

    // The new version's file and the call site are cited at the new commit;
    // the old path still reads its old content and is absent at head.
    expect(lesson.evidence).toEqual(
      expect.arrayContaining([headStock, headCaller]),
    );
    expect(headFiles[CALLER]).toContain("./stock.js");
    expect(baseFiles[OLD_PATH]).toContain("copies");
    expect(headFiles[OLD_PATH]).toBeUndefined();
    await expect(headSnapshot.exists(OLD_PATH)).resolves.toBe(false);

    // Every cited head-version line is present at head.
    for (const ref of registry.all(GENERATION_ID)) {
      if (ref.kind !== "repo" || ref.commitSha !== headSha) continue;
      const text = headFiles[ref.path];
      expect(text, ref.path).toBeDefined();
      if (ref.lines !== null) {
        expect(ref.lines.end).toBeLessThanOrEqual(text.split("\n").length);
      }
    }

    // A dependent lesson for the old commit cannot be reused for the new one.
    const ctx = makeContext({
      mode: "change",
      generation,
      registry,
      snapshot: headSnapshot,
      baseSnapshot,
      allowedCommitShas: [headSha, baseSha],
      coverage: emptyCoverage([NEW_PATH, CALLER, OLD_PATH]),
    });
    await expect(validateEvidence(lesson, ctx)).resolves.toMatchObject({
      ok: true,
    });
    const stale = await validateEvidence(
      lesson,
      makeContext({
        mode: "change",
        generation,
        registry,
        snapshot: baseSnapshot,
        baseSnapshot: null,
        allowedCommitShas: [baseSha],
        coverage: emptyCoverage([OLD_PATH, CALLER]),
      }),
    );
    expect(stale.ok).toBe(false);
    expect(
      stale.issues.some((entry) =>
        entry.message.includes("does not belong to this generation"),
      ),
    ).toBe(true);
  }, 120_000);
});
