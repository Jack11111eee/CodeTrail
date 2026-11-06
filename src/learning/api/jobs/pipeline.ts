import { lessonTitle } from "../../lessons/title.js";
/**
 * Generation, comparison and change pipelines (architecture §7.2, §7.5, §12).
 *
 * A pipeline runs against a `StagedGenerationRef`: it creates no `generations`
 * row, writes nothing to `lessons`/`sources` and only calls
 * `Publisher.publishAtomic` at the very end. Everything before that point is
 * reclaimable staging state, which is what makes a crash safe.
 *
 * Model calls go through `createModelGate` (global concurrency 2, one permit per
 * role) and `meteredHandle`, which enforces the quota pre-flight, records usage
 * for every completed call and rejects once the job's signal is aborted.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  computeCacheKey,
  computeConfigHash,
  computeScopeHash,
  DEFAULT_SCOPE,
  generationIdFromCacheKey,
  LearningError,
  stagedRef,
} from "../../contracts/index.js";
import type {
  BuildChangeLessonInput,
  BuildComparisonLessonInput,
  BuildLessonsInput,
  ComparisonPayload,
  CoverageReport,
  DiffEntry,
  DiffResult,
  GenerationConfig,
  GenerationId,
  GenerationPayload,
  JobRecord,
  JobRunnerDeps,
  Lesson,
  LessonRow,
  ModelHandle,
  ModelRole,
  NormalizedScope,
  PublishCommit,
  Repositories,
  SnapshotRecord,
  SourceRef,
  SourceRow,
  UsageKind,
} from "../../contracts/index.js";
import {
  LESSON_PIPELINE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../config/defaults.js";
import { mirrorPath } from "../../config/paths.js";
import { sourceRowFromRef } from "../../evidence/registry.js";
import { assertPublishable } from "../../lessons/builder.js";
import { git } from "../../projects/git.js";
import {
  createSnapshotReader,
  ensureBuildWorktree,
  removeBuildWorktree,
} from "../../projects/worktree.js";
import { materializeBaseline, planBaseline } from "../../upstream/baseline.js";
import {
  documentHashes,
  readCheckpoint,
  writeCheckpoint,
  type GenerationCheckpoint,
} from "./checkpoint.js";
import type { PublishGenerationExtras } from "./publish.js";

/** Thrown when the job's abort signal fires; the runner turns it into `cancelled`. */
export class JobAbortedError extends Error {
  readonly code = "cancelled";

  constructor() {
    super("job aborted");
    this.name = "JobAbortedError";
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new JobAbortedError();
}

export { createModelGate } from "../../config/metered-model.js";
export type { ModelGate } from "../../config/metered-model.js";
import { meteredHandle } from "../../config/metered-model.js";
import type { ModelGate } from "../../config/metered-model.js";
import { upstreamProgress } from "./progress.js";
import type { JobProgress } from "../../contracts/job.js";

function usageKindFor(job: JobRecord): UsageKind {
  switch (job.kind) {
    case "generation_initial":
      return "initial";
    case "generation_update":
      return "update";
    case "comparison":
      return "comparison";
    case "change_analysis":
      return "change";
  }
}

/**
 * Job-level quota pre-flight (§20, AC-GEN-20).
 *
 * The per-call gate in `instrumentChat` is the real limit, but an agent-driven
 * run reaches the model through the upstream graph, which rewraps the thrown
 * `LearningError` into a generic error and loses its code. Checking once before
 * the job dispatches anything keeps an exhausted budget a distinct
 * `budget_exhausted` failure instead of a generic `internal_error`.
 */
function assertBudgetAvailable(
  deps: JobRunnerDeps,
  model: ModelHandle,
  kind: UsageKind,
  role: ModelRole,
): void {
  const estimate = model.estimate(role, 1_000);
  const allowed = deps.usage.canSpend({
    kind,
    estimatedCalls: 1,
    estimatedInputTokens: estimate.tokens,
    estimatedOutputTokens: model.settings.maxOutputTokens,
  });
  if (!allowed) {
    throw new LearningError("budget_exhausted", "模型配额已用尽", { kind });
  }
}

// ── filesystem helpers ──────────────────────────────────────────────────────

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepository(candidate: string): Promise<boolean> {
  if (!(await exists(candidate))) return false;
  if (await exists(path.join(candidate, ".git"))) return true;
  return (
    (await exists(path.join(candidate, "HEAD"))) &&
    (await exists(path.join(candidate, "objects")))
  );
}

async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o755 });
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from), { mode: 0o644 });
    }
  }
}

/** Copies a wiki tree, skipping the upstream run checkpoint everywhere. */
async function copyWikiTree(source: string, target: string): Promise<void> {
  if (!(await exists(source))) return;
  await mkdir(target, { recursive: true, mode: 0o755 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".run.json") continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyWikiTree(from, to);
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from), { mode: 0o644 });
    }
  }
}

function normalizeScope(scope: NormalizedScope): NormalizedScope {
  if (typeof scope.hash === "string" && scope.hash !== "") return scope;
  return { ...scope, hash: computeScopeHash(scope) };
}

function defaultScope(): NormalizedScope {
  const base = {
    include: [...DEFAULT_SCOPE.include],
    exclude: [...DEFAULT_SCOPE.exclude],
    maxFiles: DEFAULT_SCOPE.maxFiles,
    maxFileBytes: DEFAULT_SCOPE.maxFileBytes,
  };
  return { ...base, hash: computeScopeHash(base) };
}

function defaultConfig(repos: Repositories): GenerationConfig {
  const settings = repos.settings.model();
  return {
    language: "zh",
    model: settings
      ? {
          provider: settings.provider,
          model: settings.model,
          ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
          maxOutputTokens: settings.maxOutputTokens,
          temperature: settings.temperature,
        }
      : {
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
  };
}

async function prepareBuildTree(
  deps: JobRunnerDeps,
  job: JobRecord,
  sha: string,
  snapshot: SnapshotRecord,
  identity: string,
): Promise<{ checkpoint: GenerationCheckpoint; resumed: boolean }> {
  const workspace = deps.publisher.buildWorkspace(job.jobId);
  let checkpoint = await readCheckpoint(workspace.stagingDir);
  // Adopt a pre-checkpoint-version native run only for this same immutable job.
  if (!checkpoint && job.attempt > 1) {
    try {
      const native = JSON.parse(
        await readFile(
          path.join(workspace.treeDir, "openwiki/.run.json"),
          "utf8",
        ),
      ) as { targetGitHead?: string; mode?: string; language?: string };
      if (
        native.targetGitHead === sha &&
        job.payload.kind === "generation" &&
        native.mode === job.payload.mode &&
        native.language === "zh"
      )
        checkpoint = {
          version: 1,
          identity,
          commitSha: sha,
          baselineFromGenerationId: null,
          fallbackReason: null,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (
    checkpoint &&
    checkpoint.identity === identity &&
    checkpoint.commitSha === sha &&
    (await exists(workspace.treeDir))
  ) {
    if (
      checkpoint.documents &&
      JSON.stringify(
        await documentHashes(path.join(workspace.treeDir, "openwiki")),
      ) !== JSON.stringify(checkpoint.documents)
    )
      throw new LearningError(
        "source_drift",
        "已完成文档的断点校验失败；文件已保留，未重新生成",
      );
    // A seal/rename may have made the derived tree read-only. Preserve it, then
    // reconstruct it from the completed document and lesson boundaries.
    if (await exists(workspace.knowledgeDir))
      await rename(
        workspace.knowledgeDir,
        path.join(
          workspace.stagingDir,
          `knowledge-before-retry-${randomUUID()}`,
        ),
      );
    await mkdir(workspace.lessonsDir, { recursive: true, mode: 0o700 });
    await writeCheckpoint(workspace.stagingDir, checkpoint);
    return { checkpoint, resumed: true };
  }
  // Incompatible state is archived, never silently thrown away on retry.
  if (await exists(workspace.stagingDir))
    await rename(
      workspace.stagingDir,
      `${workspace.stagingDir}.saved-${randomUUID()}`,
    );
  checkpoint = {
    version: 1,
    identity,
    commitSha: sha,
    baselineFromGenerationId: null,
    fallbackReason: null,
  };
  await mkdir(workspace.stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.knowledgeDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.lessonsDir, { recursive: true, mode: 0o700 });

  const repo = deps.repos.repos.byId(job.repoId);
  const mirror = repo?.mirrorPath ?? mirrorPath(deps.paths, job.repoId);
  if (await isGitRepository(mirror)) {
    await ensureBuildWorktree(
      deps.paths,
      {
        repoId: job.repoId,
        path: mirror,
        identity: repo?.identity ?? String(job.repoId),
      },
      sha,
      job.jobId,
    );
    await writeCheckpoint(workspace.stagingDir, checkpoint);
    return { checkpoint, resumed: false };
  }
  // Tests and read-only snapshots without a local mirror: the immutable
  // snapshot is the source of truth, so a copy is byte-identical.
  await copyTree(snapshot.worktreePath, workspace.treeDir);
  await chmod(workspace.treeDir, 0o755).catch(() => undefined);
  await writeCheckpoint(workspace.stagingDir, checkpoint);
  return { checkpoint, resumed: false };
}

function lessonRows(
  lessons: readonly Lesson[],
  generationId: GenerationId,
  at: string,
): LessonRow[] {
  const rows: LessonRow[] = [];
  for (const lesson of lessons) {
    const body = `${JSON.stringify(lesson, null, 2)}\n`;
    const relPath = `lessons/${lesson.lessonId}.json`;
    const jsonSha256 = createHash("sha256").update(body).digest("hex");
    const scenarioId = lesson.context?.scenarioId ?? lesson.lessonId;
    rows.push({
      lessonId: lesson.lessonId,
      generationId,
      kind: lesson.kind,
      title: lessonTitle(scenarioId, lesson.kind, lesson),
      relPath,
      jsonSha256,
      publishedAt: at,
    });
  }
  return rows;
}

async function writeLessonFiles(
  lessons: readonly Lesson[],
  generationId: GenerationId,
  lessonsDir: string,
  at: string,
): Promise<LessonRow[]> {
  const rows = lessonRows(lessons, generationId, at);
  await mkdir(lessonsDir, { recursive: true, mode: 0o700 });
  for (const lesson of lessons) {
    await writeFile(
      path.join(lessonsDir, `${lesson.lessonId}.json`),
      `${JSON.stringify(lesson, null, 2)}\n`,
      "utf8",
    );
  }
  return rows;
}

function sourceRows(
  deps: JobRunnerDeps,
  generationId: GenerationId,
): SourceRow[] {
  let refs: SourceRef[];
  try {
    refs = deps.registry.all(generationId);
  } catch (error) {
    if (
      error instanceof LearningError &&
      error.code === "unpublished_generation"
    ) {
      refs = [];
    } else {
      throw error;
    }
  }
  return refs.map((ref) => sourceRowFromRef(ref));
}

async function writeCoverage(
  knowledgeDir: string,
  coverage: CoverageReport,
): Promise<void> {
  await mkdir(knowledgeDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(knowledgeDir, "coverage.json"),
    `${JSON.stringify(coverage, null, 2)}\n`,
    "utf8",
  );
}

// ── git helpers for comparisons and changes ─────────────────────────────────

async function repositoryDir(
  deps: JobRunnerDeps,
  repoId: JobRecord["repoId"],
): Promise<string | null> {
  const repo = deps.repos.repos.byId(repoId);
  const directory = repo?.mirrorPath ?? mirrorPath(deps.paths, repoId);
  return (await isGitRepository(directory)) ? directory : null;
}

async function mergeBaseOf(
  deps: JobRunnerDeps,
  repoId: JobRecord["repoId"],
  baseSha: string,
  headSha: string,
): Promise<string> {
  const directory = await repositoryDir(deps, repoId);
  if (directory === null) return baseSha;
  const result = await git(directory, ["merge-base", baseSha, headSha]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/u.test(sha) ? sha : baseSha;
}

function statusOf(letter: string): DiffEntry["status"] | null {
  switch (letter.charAt(0).toUpperCase()) {
    case "A":
    case "C":
      return "A";
    case "M":
    case "T":
      return "M";
    case "D":
      return "D";
    case "R":
      return "R";
    default:
      return null;
  }
}

async function diffBetween(
  deps: JobRunnerDeps,
  repoId: JobRecord["repoId"],
  baseSha: string,
  headSha: string,
): Promise<DiffResult> {
  const directory = await repositoryDir(deps, repoId);
  if (directory === null) {
    return { entries: [], truncated: false, gaps: [] };
  }
  const result = await git(directory, [
    "diff",
    "--name-status",
    "-z",
    baseSha,
    headSha,
  ]);
  if (result.code !== 0) {
    return { entries: [], truncated: false, gaps: [baseSha, headSha] };
  }
  const entries: DiffEntry[] = [];
  const fields = result.stdout.split("\0").filter((field) => field !== "");
  for (let index = 0; index < fields.length;) {
    const status = statusOf(fields[index]);
    index += 1;
    if (status === null) continue;
    if (status === "R") {
      const oldPath = fields[index];
      const newPath = fields[index + 1];
      index += 2;
      if (newPath !== undefined) {
        entries.push({ path: newPath, status, oldPath });
      }
    } else {
      const file = fields[index];
      index += 1;
      if (file !== undefined) entries.push({ path: file, status });
    }
  }
  return { entries, truncated: false, gaps: [] };
}

// ── pipeline entry point ────────────────────────────────────────────────────

export interface ExecuteJobInput {
  deps: JobRunnerDeps;
  job: JobRecord;
  signal: AbortSignal;
  gate: ModelGate;
  onProgress?: (progress: JobProgress) => void;
}

function report(
  input: ExecuteJobInput,
  phase: JobProgress["phase"],
  message: string,
  extra: Partial<JobProgress> = {},
): void {
  checkAborted(input.signal);
  input.onProgress?.({ phase, done: 0, total: null, message, ...extra });
}

export interface ExecuteJobResult {
  generationId: GenerationId;
}

/**
 * Runs one job to the point where `publishAtomic` has committed. Returns the
 * published generation id. Throws `JobAbortedError` when the signal fired and
 * any `LearningError` for a real failure.
 */
export async function executeJob(
  input: ExecuteJobInput,
): Promise<ExecuteJobResult> {
  const { job } = input;
  switch (job.kind) {
    case "comparison":
      return runComparison(input);
    case "change_analysis":
      return runChange(input);
    case "generation_initial":
    case "generation_update":
      return runGeneration(input);
  }
}

function requireModel(
  deps: JobRunnerDeps,
  config?: GenerationConfig,
): ModelHandle {
  if (deps.model === null) {
    throw new LearningError("model_not_configured", "模型尚未配置", {
      reason: "no_model",
    });
  }
  return config && deps.modelForConfig
    ? deps.modelForConfig(config)
    : deps.model;
}

function repoIdentityOf(deps: JobRunnerDeps, job: JobRecord): string {
  const repo = deps.repos.repos.byId(job.repoId);
  return repo?.identity ?? `local:${deps.paths.root}/${job.repoId}`;
}

function cacheKeyFor(
  deps: JobRunnerDeps,
  job: JobRecord,
  targetCommitSha: string,
  baseContextSha: string | null,
  scope: NormalizedScope,
  config: GenerationConfig,
): string {
  return computeCacheKey({
    kind:
      job.kind === "comparison"
        ? "comparison"
        : job.kind === "change_analysis"
          ? "change"
          : "research",
    comparisonBaseSha:
      job.payload.kind === "comparison" ? job.payload.baseSha : null,
    repoIdentity: repoIdentityOf(deps, job),
    targetCommitSha,
    baseContextSha,
    scopeHash: scope.hash,
    generationConfigHash: computeConfigHash(config),
    promptTemplateVersion: config.promptTemplateVersion,
    preferencesVersion: deps.repos.prefs.version(),
    upstreamVersion: UPSTREAM_VERSION,
  });
}

async function runGeneration(
  input: ExecuteJobInput,
): Promise<ExecuteJobResult> {
  const { deps, job, signal, gate } = input;
  const payload = job.payload as GenerationPayload;
  const model = requireModel(deps, payload.config);

  report(input, "resolving", "正在解析目标提交");
  const sha = await deps.snapshotService.resolve(job.repoId, payload.commitSha);
  checkAborted(signal);
  report(input, "snapshot", "正在准备代码快照", { commitSha: sha });
  const snapshot = await deps.snapshotService.ensure(job.repoId, sha);
  const scope = normalizeScope(payload.scope);
  const config = payload.config;
  const cacheKey = cacheKeyFor(
    deps,
    job,
    sha,
    payload.baseContextSha,
    scope,
    config,
  );
  const generationId = generationIdFromCacheKey(cacheKey);

  const cached = deps.repos.generations.byCacheKey(cacheKey);
  if (cached !== null && cached.status === "published") {
    // Cache hit: zero model calls, no staging directory (AC-GEN-08).
    report(input, "publishing", "命中已发布缓存，复用已有讲解", {
      cacheHit: true,
    });
    return { generationId: cached.generationId };
  }

  const usageKind = usageKindFor(job);
  assertBudgetAvailable(deps, model, usageKind, "repo_job");

  const { checkpoint, resumed } = await prepareBuildTree(
    deps,
    job,
    sha,
    snapshot,
    generationId,
  );
  checkAborted(signal);
  const workspace = deps.publisher.buildWorkspace(job.jobId);

  // Baseline (§6.4): reuse a compatible previous generation or record why not.
  let baselineFromGenerationId =
    checkpoint.baselineFromGenerationId as GenerationId | null;
  let fallbackReason: string | null = checkpoint.fallbackReason;
  const candidate = payload.baselineFromGenerationId;
  if (!resumed && candidate !== null) {
    const repo = deps.repos.repos.byId(job.repoId);
    const plan = await planBaseline({
      candidate,
      targetSha: sha,
      language: "zh",
      ...(repo?.mirrorPath !== undefined ? { repoPath: repo.mirrorPath } : {}),
    });
    if (plan.usable && plan.source !== undefined) {
      try {
        await materializeBaseline({
          source: plan.source,
          buildWorktree: workspace.treeDir,
        });
        baselineFromGenerationId = plan.source.generationId;
      } catch {
        fallbackReason = "seal_mismatch";
        // Never let a partially copied baseline seed the full regeneration.
        await rm(path.join(workspace.treeDir, "openwiki"), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
    } else {
      fallbackReason = plan.reason ?? "no_baseline";
    }
  }
  checkAborted(signal);

  const metered = meteredHandle(model, {
    checkSignal: () => checkAborted(signal),
    kind: usageKind,
    jobId: job.jobId,
    role: "repo_job",
    signal,
    gate,
    usage: deps.usage,
  });

  checkpoint.baselineFromGenerationId = baselineFromGenerationId;
  checkpoint.fallbackReason = fallbackReason;
  await writeCheckpoint(workspace.stagingDir, checkpoint);
  report(
    input,
    checkpoint.documents ? "pages" : "planning",
    resumed ? "正在从已保存的规划和页面断点恢复" : "正在探索项目并规划文档",
    { resumeAvailable: true },
  );
  let currentProgress: JobProgress = {
    phase: "planning",
    done: 0,
    total: null,
  };
  if (!checkpoint.documents)
    await deps.upstream.run({
      worktreePath: workspace.treeDir,
      mode: payload.mode,
      language: "zh",
      modelId: model.modelId,
      model: metered.chat(),
      writeRepoFiles: false,
      onDocumentsReady: async () => {
        checkAborted(signal);
        checkpoint.documents = await documentHashes(
          path.join(workspace.treeDir, "openwiki"),
        );
        await writeCheckpoint(workspace.stagingDir, checkpoint);
      },
      onEvent: (event) => {
        if (signal.aborted) return;
        const progress = upstreamProgress(event, currentProgress);
        if (progress) {
          currentProgress = { ...currentProgress, ...progress };
          input.onProgress?.(progress);
        }
      },
    });
  checkAborted(signal);

  if (!checkpoint.documents) {
    checkpoint.documents = await documentHashes(
      path.join(workspace.treeDir, "openwiki"),
    );
    await writeCheckpoint(workspace.stagingDir, checkpoint);
  }
  await copyWikiTree(
    path.join(workspace.treeDir, "openwiki"),
    path.join(workspace.knowledgeDir, "openwiki"),
  );

  const coverage = await deps.snapshotService.coverage(
    snapshot,
    scope,
    generationId,
  );
  await writeCoverage(workspace.knowledgeDir, coverage);

  const generationRef = stagedRef({
    generationId,
    repoId: job.repoId,
    commitSha: sha,
    knowledgeDir: workspace.knowledgeDir,
    jobId: job.jobId,
    baseContextSha: payload.baseContextSha,
  });
  const reader = createSnapshotReader(snapshot, scope);
  const buildInput: BuildLessonsInput = {
    generation: generationRef,
    snapshot: reader,
    scope,
    coverage,
    model: metered,
    registry: deps.registry,
    external: deps.external,
    clock: deps.clock,
  };
  report(input, "lessons", "正在生成阅读讲解并校验代码证据");
  const result =
    checkpoint.lessons?.result ??
    (await deps.lessons.buildResearchLessons(buildInput));
  checkAborted(signal);
  report(input, "checking", "正在检查讲解是否满足发布要求");
  assertPublishable(result);
  if (!checkpoint.lessons) {
    checkpoint.lessons = { result, sources: sourceRows(deps, generationId) };
    await writeCheckpoint(workspace.stagingDir, checkpoint);
  }

  const lessons = await writeLessonFiles(
    result.lessons,
    generationId,
    workspace.lessonsDir,
    deps.clock.now().toISOString(),
  );
  report(input, "sealing", "正在保存并校验生成文件");
  const manifest = await deps.publisher.seal(
    workspace.knowledgeDir,
    generationId,
  );
  checkAborted(signal);

  const commit: PublishCommit & PublishGenerationExtras = {
    manifest,
    generationId,
    jobId: job.jobId,
    kind: "research",
    comparisonBaseSha: null,
    lessons,
    sources: checkpoint.lessons.sources,
    changeEventId: null,
    linkedEventId: null,
    linkRelation: null,
    publishedCursor: null,
    cacheKey,
    repoIdentity: repoIdentityOf(deps, job),
    baseContextSha: payload.baseContextSha,
    config,
    scope,
    preferencesVersion: deps.repos.prefs.version(),
    upstreamVersion: UPSTREAM_VERSION,
    promptTemplateVersion: config.promptTemplateVersion,
    baselineFromGenerationId,
    fallbackReason,
  };
  report(input, "publishing", "正在发布讲解");
  await deps.publisher.publishAtomic(commit);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  return { generationId };
}

async function runComparison(
  input: ExecuteJobInput,
): Promise<ExecuteJobResult> {
  const { deps, job, signal, gate } = input;
  const payload = job.payload as ComparisonPayload;
  const model = requireModel(deps, payload.config);
  report(input, "resolving", "正在解析对比版本");

  const baseSha = await deps.snapshotService.resolve(
    job.repoId,
    payload.baseSha,
  );
  const headSha = await deps.snapshotService.resolve(
    job.repoId,
    payload.headSha,
  );
  checkAborted(signal);
  report(input, "snapshot", "正在准备对比快照", { commitSha: headSha });
  const baseSnapshot = await deps.snapshotService.ensure(job.repoId, baseSha);
  const headSnapshot = await deps.snapshotService.ensure(job.repoId, headSha);
  const mergeBase = await mergeBaseOf(deps, job.repoId, baseSha, headSha);
  const scope = normalizeScope(payload.scope);
  const config = payload.config;
  const cacheKey = cacheKeyFor(deps, job, headSha, mergeBase, scope, config);
  const generationId = generationIdFromCacheKey(cacheKey);

  const cached = deps.repos.generations.byCacheKey(cacheKey);
  if (cached !== null && cached.status === "published") {
    report(input, "publishing", "命中已发布缓存，复用对比讲解", {
      cacheHit: true,
    });
    return { generationId: cached.generationId };
  }

  const usageKind = usageKindFor(job);
  assertBudgetAvailable(deps, model, usageKind, "lesson");

  const workspace = deps.publisher.buildWorkspace(job.jobId);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  await mkdir(workspace.stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.knowledgeDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.lessonsDir, { recursive: true, mode: 0o700 });
  checkAborted(signal);

  report(input, "diffing", "正在分析两个版本的代码差异");
  const diff = await diffBetween(deps, job.repoId, baseSha, headSha);
  const coverage = await deps.snapshotService.coverage(
    headSnapshot,
    scope,
    generationId,
  );
  await writeCoverage(workspace.knowledgeDir, coverage);

  const metered = meteredHandle(model, {
    checkSignal: () => checkAborted(signal),
    kind: usageKind,
    jobId: job.jobId,
    role: "lesson",
    signal,
    gate,
    usage: deps.usage,
  });

  const baseGenerationId = generationIdFromCacheKey(
    computeCacheKey({
      repoIdentity: repoIdentityOf(deps, job),
      targetCommitSha: baseSha,
      baseContextSha: null,
      scopeHash: scope.hash,
      generationConfigHash: computeConfigHash(config),
      promptTemplateVersion: config.promptTemplateVersion,
      preferencesVersion: deps.repos.prefs.version(),
      upstreamVersion: UPSTREAM_VERSION,
    }),
  );
  const baseRef = stagedRef({
    generationId: baseGenerationId,
    repoId: job.repoId,
    commitSha: baseSha,
    knowledgeDir: workspace.knowledgeDir,
    jobId: job.jobId,
    baseContextSha: null,
  });
  const headRef = stagedRef({
    generationId,
    repoId: job.repoId,
    commitSha: headSha,
    knowledgeDir: workspace.knowledgeDir,
    jobId: job.jobId,
    baseContextSha: mergeBase,
  });

  const buildInput: BuildComparisonLessonInput = {
    generation: headRef,
    base: baseRef,
    head: headRef,
    diff,
    baseSnapshot: createSnapshotReader(baseSnapshot, scope),
    headSnapshot: createSnapshotReader(headSnapshot, scope),
    scope,
    coverage,
    model: metered,
    registry: deps.registry,
    external: deps.external,
    clock: deps.clock,
  };
  report(input, "lessons", "正在生成对比讲解并校验代码证据");
  const result = await deps.lessons.buildComparisonLesson(buildInput);
  checkAborted(signal);
  report(input, "checking", "正在检查对比讲解的发布要求");
  assertPublishable(result);

  const lessons = await writeLessonFiles(
    result.lessons,
    generationId,
    workspace.lessonsDir,
    deps.clock.now().toISOString(),
  );
  report(input, "sealing", "正在保存并校验生成文件");
  const manifest = await deps.publisher.seal(
    workspace.knowledgeDir,
    generationId,
  );
  checkAborted(signal);

  const commit: PublishCommit & PublishGenerationExtras = {
    manifest,
    generationId,
    jobId: job.jobId,
    kind: "comparison",
    comparisonBaseSha: baseSha,
    lessons,
    sources: sourceRows(deps, generationId),
    changeEventId: null,
    linkedEventId: null,
    linkRelation: null,
    publishedCursor: null,
    cacheKey,
    repoIdentity: repoIdentityOf(deps, job),
    baseContextSha: mergeBase,
    config,
    scope,
    preferencesVersion: deps.repos.prefs.version(),
    upstreamVersion: UPSTREAM_VERSION,
    promptTemplateVersion: config.promptTemplateVersion,
  };
  report(input, "publishing", "正在发布对比讲解");
  await deps.publisher.publishAtomic(commit);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  return { generationId };
}

async function runChange(input: ExecuteJobInput): Promise<ExecuteJobResult> {
  const { deps, job, signal, gate } = input;
  const payload = job.payload as Extract<
    JobRecord["payload"],
    { kind: "change" }
  >;
  const model = requireModel(deps);

  report(input, "resolving", "正在解析变更版本");
  const event = deps.repos.changes.byId(payload.eventId);
  if (event === null) {
    throw new LearningError("not_found", "变更事件不存在", {
      eventId: payload.eventId,
    });
  }
  const baseSha = await deps.snapshotService.resolve(
    job.repoId,
    payload.baseSha,
  );
  const headSha = await deps.snapshotService.resolve(
    job.repoId,
    payload.headSha,
  );
  checkAborted(signal);
  report(input, "snapshot", "正在准备变更快照", { commitSha: headSha });
  const baseSnapshot = await deps.snapshotService.ensure(job.repoId, baseSha);
  const headSnapshot = await deps.snapshotService.ensure(job.repoId, headSha);
  const project =
    job.projectId === null ? null : deps.repos.projects.byId(job.projectId);
  const scope = normalizeScope(project?.scope ?? defaultScope());
  const config = defaultConfig(deps.repos);
  const cacheKey = cacheKeyFor(
    deps,
    job,
    headSha,
    payload.mergeBaseSha,
    scope,
    config,
  );
  const generationId = generationIdFromCacheKey(cacheKey);

  const usageKind = usageKindFor(job);
  assertBudgetAvailable(deps, model, usageKind, "change");

  const workspace = deps.publisher.buildWorkspace(job.jobId);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  await mkdir(workspace.stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.knowledgeDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.lessonsDir, { recursive: true, mode: 0o700 });
  checkAborted(signal);

  report(input, "diffing", "正在分析本次变更的代码差异");
  const diff = await diffBetween(deps, job.repoId, baseSha, headSha);
  const coverage = await deps.snapshotService.coverage(
    headSnapshot,
    scope,
    generationId,
  );
  await writeCoverage(workspace.knowledgeDir, coverage);

  const metered = meteredHandle(model, {
    checkSignal: () => checkAborted(signal),
    kind: usageKind,
    jobId: job.jobId,
    role: "change",
    signal,
    gate,
    usage: deps.usage,
  });

  const generationRef = stagedRef({
    generationId,
    repoId: job.repoId,
    commitSha: headSha,
    knowledgeDir: workspace.knowledgeDir,
    jobId: job.jobId,
    baseContextSha: payload.mergeBaseSha,
  });
  const buildInput: BuildChangeLessonInput = {
    generation: generationRef,
    event: event,
    diff,
    baseSnapshot: createSnapshotReader(baseSnapshot, scope),
    headSnapshot: createSnapshotReader(headSnapshot, scope),
    scope,
    model: metered,
    registry: deps.registry,
    external: deps.external,
    clock: deps.clock,
  };
  report(input, "lessons", "正在生成变更讲解并校验代码证据");
  const result = await deps.lessons.buildChangeLesson(buildInput);
  checkAborted(signal);
  report(input, "checking", "正在检查变更讲解的发布要求");
  assertPublishable(result);

  const lessons = await writeLessonFiles(
    result.lessons,
    generationId,
    workspace.lessonsDir,
    deps.clock.now().toISOString(),
  );
  report(input, "sealing", "正在保存并校验生成文件");
  const manifest = await deps.publisher.seal(
    workspace.knowledgeDir,
    generationId,
  );
  checkAborted(signal);

  const commit: PublishCommit & PublishGenerationExtras = {
    manifest,
    generationId,
    jobId: job.jobId,
    kind: "change",
    comparisonBaseSha: null,
    lessons,
    sources: sourceRows(deps, generationId),
    changeEventId: payload.eventId,
    linkedEventId: event.linkedEventId,
    linkRelation: event.linkRelation,
    publishedCursor: null,
    cacheKey,
    repoIdentity: repoIdentityOf(deps, job),
    baseContextSha: payload.mergeBaseSha,
    config,
    scope,
    preferencesVersion: deps.repos.prefs.version(),
    upstreamVersion: UPSTREAM_VERSION,
    promptTemplateVersion: config.promptTemplateVersion,
  };
  report(input, "publishing", "正在发布变更讲解");
  await deps.publisher.publishAtomic(commit);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  return { generationId };
}
