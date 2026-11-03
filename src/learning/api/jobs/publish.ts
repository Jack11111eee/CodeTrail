/**
 * Publish protocol (architecture §7.3, §7.4).
 *
 * `createPublisher` is the only module that turns a staged knowledge directory
 * into a published generation. The order is fixed and is the whole durability
 * story: **seal → rename → one `BEGIN IMMEDIATE` transaction**. A crash before
 * the rename leaves the old generation untouched; a crash after the rename but
 * before the commit leaves an unreferenced directory that GC can reclaim; a
 * crash after the commit exposes exactly the new generation. There is no state
 * in which the database points at a partially written directory.
 *
 * `buildWorkspace` is the only other constructor of the per-job build area
 * (`config/paths.ts` being the first); both compute the same three directories,
 * so GC can safely walk `paths.staging` and match job ids.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  ALLOWED_JOB_TRANSITIONS,
  computeCacheKey,
  computeConfigHash,
  computeScopeHash,
  computeSealTreeHash,
  DEFAULT_SCOPE,
  LearningError,
} from "../../contracts/index.js";
import type {
  BuildWorkspace,
  Clock,
  DataPaths,
  Database,
  GenerationConfig,
  GenerationId,
  GenerationRecord,
  JobId,
  NormalizedScope,
  Publisher,
  PublishCommit,
  Repositories,
  SealManifest,
  SealedFile,
  GcReport,
} from "../../contracts/index.js";
import {
  knowledgePath,
  stagingKnowledgePath,
  stagingPath,
  stagingTreePath,
} from "../../config/paths.js";
import {
  LESSON_PIPELINE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../config/defaults.js";
import { faultPoint } from "../../testing/faults.js";

// Declared in contracts/ports.ts (§3.13); re-export only.
export type {
  SealedFile,
  SealManifest,
  BuildWorkspace,
  PublishCommit,
  Publisher,
  GcReport,
} from "../../contracts/index.js";

/** Location of the seal manifest at the knowledge root. */
export const SEAL_BASENAME = "seal.json";

/**
 * Optional generation facts the pipeline knows and `PublishCommit` (a frozen
 * contract) cannot carry. The publisher derives the same values from the job
 * when they are absent, so a caller that only has the contract still works.
 */
export interface PublishGenerationExtras {
  cacheKey?: string;
  repoIdentity?: string;
  baseContextSha?: string | null;
  config?: GenerationConfig;
  scope?: NormalizedScope;
  preferencesVersion?: number;
  upstreamVersion?: string;
  promptTemplateVersion?: string;
  baselineFromGenerationId?: GenerationId | null;
  fallbackReason?: string | null;
  createdAt?: string;
  publishedAt?: string;
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, "/");
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively lists regular files below `root`, sorted by their POSIX relative
 * path. Symlinks are ignored: a generation contains files only.
 */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  await walk(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

/** Restores owner write bits so a sealed tree can be re-sealed or removed. */
async function makeTreeWritable(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeTreeWritable(child);
      await chmod(child, 0o755).catch(() => undefined);
    } else {
      await chmod(child, 0o644).catch(() => undefined);
    }
  }
  await chmod(root, 0o755).catch(() => undefined);
}

/**
 * Removes write bits from every file and nested directory below `root`.
 *
 * The root itself keeps its owner write bit: `rename(2)` moves the directory
 * entry, and macOS refuses to rename a directory whose own mode is read-only.
 * Seal integrity is about the files, which are all `0444` after this call.
 */
async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeTreeReadOnly(child);
      await chmod(child, 0o555).catch(() => undefined);
    } else {
      await chmod(child, 0o444).catch(() => undefined);
    }
  }
  await chmod(root, 0o755).catch(() => undefined);
}

async function removeTree(root: string): Promise<void> {
  if (!(await exists(root))) return;
  await makeTreeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function treeBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        total += (await stat(child)).size;
      }
    }
  };
  await walk(root);
  return total;
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "w", 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The five fields `seal.json` records for every file. */
async function sealFiles(root: string): Promise<SealedFile[]> {
  const files: SealedFile[] = [];
  for (const relative of await listFiles(root)) {
    if (relative === SEAL_BASENAME) continue;
    const content = await readFile(path.join(root, relative));
    files.push({
      path: toPosix(relative),
      sha256: sha256Hex(content),
      bytes: content.byteLength,
    });
  }
  return files;
}

interface DerivedGeneration {
  cacheKey: string;
  repoId: string;
  commitSha: string;
  comparisonBaseSha: string | null;
  config: GenerationConfig;
  scope: NormalizedScope;
  baseContextSha: string | null;
  preferencesVersion: number;
  upstreamVersion: string;
  promptTemplateVersion: string;
  projectId: string | null;
  createdAt: string;
}

const DEFAULT_CONFIG: GenerationConfig = Object.freeze({
  language: "zh",
  model: {
    provider: "unknown",
    model: "unknown",
    maxOutputTokens: 1024,
    temperature: 0,
  },
  pageConcurrency: 1,
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  lessonPipelineVersion: LESSON_PIPELINE_VERSION,
  includeTests: false,
  externalDocs: { enabled: false, maxPerLesson: 0 },
});

function normalizeScope(scope: NormalizedScope | undefined): NormalizedScope {
  if (scope === undefined) {
    const base = {
      include: [...DEFAULT_SCOPE.include],
      exclude: [...DEFAULT_SCOPE.exclude],
      maxFiles: DEFAULT_SCOPE.maxFiles,
      maxFileBytes: DEFAULT_SCOPE.maxFileBytes,
    };
    return { ...base, hash: computeScopeHash(base) };
  }
  if (typeof scope.hash === "string" && scope.hash !== "") return scope;
  return { ...scope, hash: computeScopeHash(scope) };
}

/**
 * Reconstructs the generation row a `PublishCommit` does not carry. Prefers the
 * exact values the pipeline passed as extras and falls back to the job payload
 * so a caller using only the contract still publishes a coherent row.
 */
function deriveGeneration(
  input: PublishCommit,
  extras: PublishGenerationExtras,
  deps: { paths: DataPaths; repos: Repositories; clock: Clock },
): DerivedGeneration {
  const job = deps.repos.jobs.byId(input.jobId);
  if (job === null) {
    throw new LearningError("internal_error", "发布任务不存在", {
      jobId: input.jobId,
    });
  }
  const payload = job.payload;

  let commitSha: string;
  let comparisonBaseSha: string | null = input.comparisonBaseSha;
  let baseContextSha: string | null = extras.baseContextSha ?? null;
  let config: GenerationConfig;
  let scope: NormalizedScope;

  if (payload.kind === "generation") {
    commitSha = payload.commitSha;
    baseContextSha = extras.baseContextSha ?? payload.baseContextSha;
    config = extras.config ?? payload.config;
    scope = normalizeScope(extras.scope ?? payload.scope);
  } else if (payload.kind === "comparison") {
    commitSha = payload.headSha;
    comparisonBaseSha = input.comparisonBaseSha ?? payload.baseSha;
    baseContextSha = extras.baseContextSha ?? comparisonBaseSha;
    config = extras.config ?? payload.config;
    scope = normalizeScope(extras.scope ?? payload.scope);
  } else {
    commitSha = payload.headSha;
    const project =
      job.projectId === null ? null : deps.repos.projects.byId(job.projectId);
    const settings = deps.repos.settings.model();
    config = extras.config ?? {
      ...DEFAULT_CONFIG,
      model: settings
        ? {
            provider: settings.provider,
            model: settings.model,
            maxOutputTokens: settings.maxOutputTokens,
            temperature: settings.temperature,
          }
        : DEFAULT_CONFIG.model,
    };
    scope = normalizeScope(extras.scope ?? project?.scope);
  }

  const repo = deps.repos.repos.byId(job.repoId);
  const repoIdentity =
    extras.repoIdentity ?? repo?.identity ?? `local:${deps.paths.root}`;
  const scopeHash = scope.hash;
  const configHash = computeConfigHash(config);
  const promptTemplateVersion =
    extras.promptTemplateVersion ?? config.promptTemplateVersion;
  const preferencesVersion =
    extras.preferencesVersion ?? deps.repos.prefs.version();
  const upstreamVersion = extras.upstreamVersion ?? UPSTREAM_VERSION;
  const cacheKey =
    extras.cacheKey ??
    computeCacheKey({
      repoIdentity,
      targetCommitSha: commitSha,
      baseContextSha,
      scopeHash,
      generationConfigHash: configHash,
      promptTemplateVersion,
      preferencesVersion,
      upstreamVersion,
    });

  return {
    cacheKey,
    repoId: job.repoId,
    commitSha,
    comparisonBaseSha,
    config,
    scope,
    baseContextSha,
    preferencesVersion,
    upstreamVersion,
    promptTemplateVersion,
    projectId: job.projectId,
    createdAt: extras.createdAt ?? deps.clock.now().toISOString(),
  };
}

/** Implements `Publisher` (§7.3, §7.4). */
export function createPublisher(deps: {
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: Clock;
}): Publisher {
  const { paths, db, repos, clock } = deps;

  return {
    buildWorkspace(jobId: JobId): BuildWorkspace {
      const knowledgeDir = stagingKnowledgePath(paths, jobId);
      return {
        stagingDir: stagingPath(paths, jobId),
        treeDir: stagingTreePath(paths, jobId),
        knowledgeDir,
        lessonsDir: path.join(knowledgeDir, "lessons"),
      };
    },

    async seal(workspaceDir: string, generationId: GenerationId): Promise<SealManifest> {
      // Fault point 14 (§7.2): the process dies before seal.json exists, so a
      // restart sees an unsealed staging directory and the old version intact.
      faultPoint("seal");

      if (!(await isDirectory(workspaceDir))) {
        throw new LearningError("internal_error", "暂存目录不存在", {
          workspaceDir,
        });
      }
      // A retry may re-seal a previously sealed tree; restore write bits first.
      await makeTreeWritable(workspaceDir);

      const files = await sealFiles(workspaceDir);
      const manifest: SealManifest = {
        schemaVersion: 1,
        generationId,
        treeHash: computeSealTreeHash(files),
        files,
      };
      await writeJsonFile(path.join(workspaceDir, SEAL_BASENAME), manifest);
      // `seal.json` itself is read-only and is not part of its own list.
      await chmod(path.join(workspaceDir, SEAL_BASENAME), 0o444).catch(
        () => undefined,
      );
      await makeTreeReadOnly(workspaceDir);
      return manifest;
    },

    async publishAtomic(input: PublishCommit): Promise<void> {
      const job = repos.jobs.byId(input.jobId);
      if (job === null) {
        throw new LearningError("internal_error", "发布任务不存在", {
          jobId: input.jobId,
        });
      }
      if (job.state === "cancelled" || job.state === "cancelling") {
        throw new LearningError("conflict", "任务已取消", {
          jobId: input.jobId,
          state: job.state,
        });
      }

      const sourceDir = stagingKnowledgePath(paths, input.jobId);
      const targetDir = knowledgePath(paths, input.generationId);
      const alreadyPublished =
        repos.generations.byId(input.generationId)?.status === "published";

      if (!alreadyPublished) {
        faultPoint("rename");
        if (await exists(targetDir)) {
          // A previous attempt renamed the tree but never committed. It is
          // unreferenced and safe to replace with the fresh staging tree; if
          // there is no fresh tree, reuse the renamed one.
          if (await exists(sourceDir)) {
            await removeTree(targetDir);
            await rename(sourceDir, targetDir);
          }
        } else {
          if (!(await exists(sourceDir))) {
            throw new LearningError("internal_error", "暂存知识目录不存在", {
              jobId: input.jobId,
            });
          }
          await rename(sourceDir, targetDir);
        }
      }

      const generation = deriveGeneration(input, input as PublishGenerationExtras, {
        paths,
        repos,
        clock,
      });
      const now = clock.now().toISOString();

      faultPoint("tx_before");
      db.transaction(() => {
        // Re-read inside the transaction: a cancel may have landed while the
        // staging tree was being renamed. Publishing a generation for a job
        // that is no longer running would violate AC-GEN-03, so roll back and
        // leave the renamed directory unreferenced for GC.
        const current = repos.jobs.byId(input.jobId);
        if (
          current === null ||
          current.state === "cancelled" ||
          current.state === "cancelling"
        ) {
          throw new LearningError("conflict", "任务已取消", {
            jobId: input.jobId,
            state: current?.state ?? "missing",
          });
        }

        const record: GenerationRecord = {
          generationId: input.generationId,
          cacheKey: generation.cacheKey,
          repoId: generation.repoId as GenerationRecord["repoId"],
          projectId: generation.projectId as GenerationRecord["projectId"],
          commitSha: generation.commitSha,
          comparisonBaseSha: input.comparisonBaseSha,
          kind: input.kind,
          scopeHash: generation.scope.hash,
          configHash: computeConfigHash(generation.config),
          promptTemplateVersion: generation.promptTemplateVersion,
          preferencesVersion: generation.preferencesVersion,
          upstreamVersion: generation.upstreamVersion,
          status: "published",
          contentDir: targetDir,
          sealedTreeHash: input.manifest.treeHash,
          baselineFromGenerationId:
            (input as PublishGenerationExtras).baselineFromGenerationId ?? null,
          fallbackReason:
            (input as PublishGenerationExtras).fallbackReason ?? null,
          jobId: input.jobId,
          createdAt: generation.createdAt,
          publishedAt: now,
        };

        const existing = repos.generations.byId(input.generationId);
        if (existing === null) {
          repos.generations.insertPublished(record);
        }

        if (input.lessons.length > 0) repos.lessons.insertMany(input.lessons);
        if (input.sources.length > 0) repos.sources.insertMany(input.sources);

        if (input.changeEventId !== null) {
          repos.changes.setState(input.changeEventId, "published", {
            publishedAt: now,
          });
          if (input.linkedEventId !== null && input.linkRelation !== null) {
            repos.changes.link({
              prEventId: input.changeEventId,
              defaultBranchEventId: input.linkedEventId,
              relation: input.linkRelation,
            });
          }
        }

        if (input.publishedCursor !== null) {
          const advanced = repos.cursors.put(input.publishedCursor);
          if (!advanced) {
            throw new LearningError("conflict", "发布游标已被推进", {
              streamId: input.publishedCursor.streamId,
            });
          }
        }

        if (ALLOWED_JOB_TRANSITIONS[current.state].includes("completed")) {
          repos.jobs.transition(input.jobId, [current.state], "completed", {
            outputGenerationId: input.generationId,
            finishedAt: now,
            errorCode: null,
            errorDetail: null,
          });
        }

        const attempt = repos.attempts
          .list(input.jobId)
          .find((entry) => entry.state === "running");
        if (attempt !== undefined) {
          repos.attempts.close(
            input.jobId,
            attempt.attempt,
            "completed",
            now,
            null,
          );
        }
      });
      // Fault point 16 (§7.2): the commit already happened, so a restart sees
      // exactly the new generation and a completed job.
      faultPoint("tx_after");
    },

    async gc(opts?: { reclaimRemovedProjects?: boolean }): Promise<GcReport> {
      void opts;
      const report: GcReport = {
        removedWorkspaces: [],
        removedKnowledge: [],
        keptPublished: 0,
        keptInFlight: 0,
        bytesFreed: 0,
      };

      // Reclaim every staging workspace whose job is not still running.
      let stagingEntries: Dirent[];
      try {
        stagingEntries = await readdir(paths.staging, { withFileTypes: true });
      } catch {
        stagingEntries = [];
      }
      for (const entry of stagingEntries) {
        if (!entry.isDirectory()) continue;
        const workspace = path.join(paths.staging, entry.name);
        const job = repos.jobs.byId(entry.name as JobId);
        // AC-OPS-04: a directory referenced by a queued, running or cancelling
        // job is in flight and must be retained.
        if (
          job !== null &&
          (job.state === "queued" ||
            job.state === "running" ||
            job.state === "cancelling")
        ) {
          report.keptInFlight += 1;
          continue;
        }
        report.bytesFreed += await treeBytes(workspace);
        await removeTree(workspace);
        report.removedWorkspaces.push(workspace);
      }

      // Reclaim knowledge directories that no published generation references.
      let knowledgeEntries: Dirent[];
      try {
        knowledgeEntries = await readdir(paths.knowledge, { withFileTypes: true });
      } catch {
        knowledgeEntries = [];
      }
      for (const entry of knowledgeEntries) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(paths.knowledge, entry.name);
        const record = repos.generations.byId(entry.name as GenerationId);
        if (record !== null && record.status === "published") {
          report.keptPublished += 1;
          continue;
        }
        report.bytesFreed += await treeBytes(directory);
        await removeTree(directory);
        report.removedKnowledge.push(entry.name as GenerationId);
      }

      return report;
    },
  };
}
