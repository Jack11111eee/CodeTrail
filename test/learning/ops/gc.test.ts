import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  GenerationId,
  JobId,
  JobRecord,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import {
  knowledgePath,
  mirrorPath,
  resolveDataPaths,
  stagingPath,
  worktreePath,
} from "../../../src/learning/config/paths.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";

/**
 * AC-OPS-04: `gc` reclaims only unreferenced staging/knowledge directories,
 * keeps every directory owned by a queued/running job or a published
 * generation, never touches `mirrors/**` or `work/**`, and is idempotent.
 *
 * The keep-set is derived from `jobs.state` / `generations.status`; directory
 * age is never consulted, so this test also proves a published version survives
 * a second sweep.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "gc.mjs");
const NOW = "2026-01-01T00:00:00.000Z";
const REPO = "r_gctest" as RepoId;

const tempDirs: string[] = [];
const openDbs: { close: () => void }[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-gc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

interface Seed {
  dataDir: string;
  publishedFile: string;
  publishedSha: string;
  orphanStaging: string;
  orphanKnowledge: string;
  queuedStaging: string;
  runningStaging: string;
  mirror: string;
  worktree: string;
}

function seed(): Seed {
  const dataDir = makeTempDir();
  const paths = resolveDataPaths({ ...process.env, CODETRAIL_DATA_DIR: dataDir });
  fs.mkdirSync(paths.root, { recursive: true });
  // `ensureDataDir` is async; the directories this test needs are created
  // synchronously by the helpers below, so only the db parent matters.
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  fs.mkdirSync(paths.knowledge, { recursive: true });
  fs.mkdirSync(paths.staging, { recursive: true });
  fs.mkdirSync(paths.mirrors, { recursive: true });
  fs.mkdirSync(paths.work, { recursive: true });

  const clock = createClock(NOW);
  const db = openDatabase({ file: paths.db, clock });
  openDbs.push(db);
  migrate(db);
  const repos = createRepositories(db);

  repos.repos.upsert({
    repoId: REPO,
    identity: `local:${dataDir}`,
    kind: "local",
    mirrorPath: mirrorPath(paths, REPO),
    remoteUrl: null,
    createdAt: NOW,
  });

  const publishedId = "g_published" as GenerationId;
  const publishedDir = knowledgePath(paths, publishedId);
  const publishedFile = path.join(publishedDir, "lesson.json");
  writeFile(publishedFile, JSON.stringify({ lesson: "published" }));
  repos.generations.insertPublished({
    generationId: publishedId,
    cacheKey: "sha256:cache-published",
    repoId: REPO,
    projectId: null,
    commitSha: "a".repeat(40),
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: normalizeScope().hash,
    configHash: "sha256:config",
    promptTemplateVersion: "lp1",
    preferencesVersion: 1,
    upstreamVersion: "0.7.2",
    status: "published",
    contentDir: publishedDir,
    sealedTreeHash: "sha256:sealed",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: NOW,
    publishedAt: NOW,
  });

  const payload = {
    kind: "generation",
    mode: "init",
    ref: "main",
    commitSha: "b".repeat(40),
    baseContextSha: null,
    scope: normalizeScope(),
    config: {
      language: "zh",
      model: { provider: "x", model: "y", maxOutputTokens: 1, temperature: 0 },
      pageConcurrency: 1,
      promptTemplateVersion: "lp1",
      lessonPipelineVersion: "lp1",
      includeTests: false,
      externalDocs: { enabled: false, maxPerLesson: 0 },
    },
    baselineFromGenerationId: null,
  };

  const insertJob = (jobId: string, state: JobRecord["state"], dedupe: string) => {
    repos.jobs.insert({
      jobId: jobId as JobId,
      dedupeKey: dedupe,
      kind: "generation_initial",
      repoId: REPO,
      projectId: null,
      streamId: null,
      state,
      payload: payload as unknown as JobRecord["payload"],
      attempt: 1,
      errorCode: null,
      errorDetail: null,
      progress: null,
      outputGenerationId: null,
      createdAt: NOW,
      startedAt: state === "running" ? NOW : null,
      finishedAt: null,
    });
  };
  insertJob("j_queued", "queued", "dedupe-queued");
  insertJob("j_running", "running", "dedupe-running");
  insertJob("j_completed", "completed", "dedupe-completed");

  const orphanStaging = stagingPath(paths, "j_orphan" as JobId);
  writeFile(path.join(orphanStaging, "junk.txt"), "junk");
  const queuedStaging = stagingPath(paths, "j_queued" as JobId);
  writeFile(path.join(queuedStaging, "tree", "keep.txt"), "queued");
  const runningStaging = stagingPath(paths, "j_running" as JobId);
  writeFile(path.join(runningStaging, "tree", "keep.txt"), "running");
  const completedStaging = stagingPath(paths, "j_completed" as JobId);
  writeFile(path.join(completedStaging, "tree", "junk.txt"), "completed");

  const orphanKnowledge = knowledgePath(paths, "g_orphan" as GenerationId);
  writeFile(path.join(orphanKnowledge, "junk.txt"), "junk");

  const mirror = mirrorPath(paths, REPO);
  writeFile(path.join(mirror, "HEAD"), "ref: refs/heads/main\n");
  const worktree = worktreePath(paths, REPO, "a".repeat(40));
  writeFile(path.join(worktree, "src", "index.ts"), "export const keep = true;\n");

  return {
    dataDir,
    publishedFile,
    publishedSha: sha256(publishedFile),
    orphanStaging,
    orphanKnowledge,
    queuedStaging,
    runningStaging,
    mirror,
    worktree,
  };
}

function runGcScript(dataDir: string) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--json", "--data-dir", dataDir],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    removedWorkspaces: string[];
    removedKnowledge: string[];
    keptPublished: number;
    keptInFlight: number;
    bytesFreed: number;
  };
}

describe("gc", () => {
  it("reclaims orphans, keeps published and in-flight directories, and never touches mirrors/work", () => {
    const seeded = seed();
    const report = runGcScript(seeded.dataDir);

    expect(report.removedWorkspaces).toContain(seeded.orphanStaging);
    expect(report.removedWorkspaces).not.toContain(seeded.queuedStaging);
    expect(report.removedWorkspaces).not.toContain(seeded.runningStaging);
    expect(report.removedKnowledge).toContain("g_orphan");
    expect(report.keptPublished).toBe(1);
    expect(report.keptInFlight).toBe(2);
    expect(report.bytesFreed).toBeGreaterThan(0);

    expect(fs.existsSync(seeded.orphanStaging)).toBe(false);
    expect(fs.existsSync(seeded.orphanKnowledge)).toBe(false);
    expect(fs.existsSync(seeded.queuedStaging)).toBe(true);
    expect(fs.existsSync(seeded.runningStaging)).toBe(true);
    expect(fs.existsSync(seeded.mirror)).toBe(true);
    expect(fs.existsSync(seeded.worktree)).toBe(true);

    // The published version is byte-identical after the sweep.
    expect(fs.existsSync(seeded.publishedFile)).toBe(true);
    expect(sha256(seeded.publishedFile)).toBe(seeded.publishedSha);
  });

  it("is idempotent and never deletes a published version", () => {
    const seeded = seed();
    runGcScript(seeded.dataDir);
    const second = runGcScript(seeded.dataDir);

    expect(second.removedWorkspaces).toEqual([]);
    expect(second.removedKnowledge).toEqual([]);
    expect(second.keptPublished).toBe(1);
    expect(second.keptInFlight).toBe(2);
    expect(second.bytesFreed).toBe(0);
    expect(fs.existsSync(seeded.publishedFile)).toBe(true);
    expect(sha256(seeded.publishedFile)).toBe(seeded.publishedSha);
  });
});
