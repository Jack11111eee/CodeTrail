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

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
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
  ChatModelLike,
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
  MODEL_CONCURRENCY,
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
import {
  materializeBaseline,
  planBaseline,
} from "../../upstream/baseline.js";
import type {
  PublishGenerationExtras,
} from "./publish.js";

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

// ── model concurrency gate (§20) ────────────────────────────────────────────

/** Per-role permits: one repo job, one page worker and one QA slot (§20). */
const ROLE_PERMITS: Readonly<Record<ModelRole, number>> = Object.freeze({
  repo_job: 1,
  page_worker: 1,
  lesson: 1,
  qa: 1,
  change: 1,
});

export interface ModelGate {
  run<T>(role: ModelRole, task: () => Promise<T>): Promise<T>;
  active(): number;
  maxActive(): number;
  activeFor(role: ModelRole): number;
  maxActiveFor(role: ModelRole): number;
}

/**
 * Global concurrency is `MODEL_CONCURRENCY` (2) with at most one permit per
 * role. A permit is released in `finally`, including on abort.
 */
export function createModelGate(): ModelGate {
  let active = 0;
  let maxActive = 0;
  const activeByRole: Partial<Record<ModelRole, number>> = {};
  const maxByRole: Partial<Record<ModelRole, number>> = {};
  const waiters: (() => void)[] = [];

  const canAcquire = (role: ModelRole): boolean =>
    active < MODEL_CONCURRENCY &&
    (activeByRole[role] ?? 0) < (ROLE_PERMITS[role] ?? 1);

  const wake = (): void => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  const acquire = async (role: ModelRole): Promise<void> => {
    while (!canAcquire(role)) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    activeByRole[role] = (activeByRole[role] ?? 0) + 1;
    maxActive = Math.max(maxActive, active);
    maxByRole[role] = Math.max(maxByRole[role] ?? 0, activeByRole[role] ?? 0);
  };

  const release = (role: ModelRole): void => {
    active -= 1;
    activeByRole[role] = Math.max(0, (activeByRole[role] ?? 0) - 1);
    wake();
  };

  return {
    async run<T>(role: ModelRole, task: () => Promise<T>): Promise<T> {
      await acquire(role);
      try {
        return await task();
      } finally {
        release(role);
      }
    },
    active: () => active,
    maxActive: () => maxActive,
    activeFor: (role) => activeByRole[role] ?? 0,
    maxActiveFor: (role) => maxByRole[role] ?? 0,
  };
}

// ── usage / quota instrumentation ───────────────────────────────────────────

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(0, Math.ceil(text.length / 4));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (
        block !== null &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function tokensOf(result: unknown, args: unknown[]): {
  input: number;
  output: number;
} {
  if (result !== null && typeof result === "object") {
    const usage = (result as { usage_metadata?: Record<string, unknown> })
      .usage_metadata;
    if (usage !== undefined) {
      const input = Number(usage.input_tokens ?? 0);
      const output = Number(usage.output_tokens ?? 0);
      if (input > 0 || output > 0) return { input, output };
    }
    const metadata = (result as { response_metadata?: Record<string, unknown> })
      .response_metadata;
    const tokenUsage = metadata?.tokenUsage as
      | Record<string, unknown>
      | undefined;
    if (tokenUsage !== undefined) {
      const input = Number(
        tokenUsage.promptTokens ?? tokenUsage.inputTokens ?? 0,
      );
      const output = Number(
        tokenUsage.completionTokens ?? tokenUsage.outputTokens ?? 0,
      );
      if (input > 0 || output > 0) return { input, output };
    }
    return {
      input: estimateTokens(args),
      output: estimateTokens(contentText((result as { content?: unknown }).content)),
    };
  }
  return { input: estimateTokens(args), output: 0 };
}

function costCentsFor(
  model: ModelHandle,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = model.settings.pricing;
  if (pricing === null) return null;
  return Math.round(
    (inputTokens / 1_000_000) * pricing.inputCentsPerMTok +
      (outputTokens / 1_000_000) * pricing.outputCentsPerMTok,
  );
}

interface MeterOptions {
  kind: UsageKind;
  jobId: JobRecord["jobId"];
  role: ModelRole;
  signal: AbortSignal;
  gate: ModelGate;
  usage: JobRunnerDeps["usage"];
}

function boundMember(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  return typeof value === "function"
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

function instrumentChat(
  base: ChatModelLike,
  model: ModelHandle,
  options: MeterOptions,
): ChatModelLike {
  const invoke = async (target: object, args: unknown[]): Promise<unknown> => {
    checkAborted(options.signal);
    const estimate = model.estimate(options.role, 1_000);
    const allowed = options.usage.canSpend({
      kind: options.kind,
      estimatedCalls: 1,
      estimatedInputTokens: estimate.tokens,
      estimatedOutputTokens: model.settings.maxOutputTokens,
    });
    if (!allowed) {
      throw new LearningError("budget_exhausted", "模型配额已用尽", {
        kind: options.kind,
      });
    }
    const callable = target as {
      invoke: (...a: never[]) => Promise<unknown>;
    };
    const result = await options.gate.run(options.role, () =>
      callable.invoke(...(args as never[])),
    );
    // Record before checking the abort signal: a call that completed while a
    // cancellation was in flight still consumed tokens (AC-GEN-03).
    const { input, output } = tokensOf(result, args);
    options.usage.record({
      kind: options.kind,
      jobId: options.jobId,
      conversationId: null,
      provider: model.settings.provider,
      model: model.settings.model,
      inputTokens: input,
      outputTokens: output,
      calls: 1,
      costCents: costCentsFor(model, input, output),
    });
    checkAborted(options.signal);
    return result;
  };

  const wrapRunnable = (bound: object): object =>
    new Proxy(bound, {
      get(target, prop) {
        if (prop === "invoke") {
          return (...args: unknown[]) => invoke(target, args);
        }
        if (prop === "stream") {
          return (...args: unknown[]) => invoke(target, args);
        }
        return boundMember(target, prop);
      },
    });

  return new Proxy(base, {
    get(target, prop) {
      if (prop === "invoke" || prop === "stream") {
        return (...args: unknown[]) => invoke(target, args);
      }
      if (prop === "bindTools") {
        return (...args: unknown[]) => {
          const bind = Reflect.get(target, "bindTools", target) as (
            ...a: unknown[]
          ) => object;
          return wrapRunnable(bind.apply(target, args));
        };
      }
      return boundMember(target, prop);
    },
  });
}

function meteredHandle(model: ModelHandle, options: MeterOptions): ModelHandle {
  return {
    modelId: model.modelId,
    settings: model.settings,
    estimate: (role, promptTokens) => model.estimate(role, promptTokens),
    chat: () => instrumentChat(model.chat(), model, options),
  };
}

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
): Promise<void> {
  // A retry after a crash may find a half-sealed staging tree; start clean.
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  const workspace = deps.publisher.buildWorkspace(job.jobId);
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
    return;
  }
  // Tests and read-only snapshots without a local mirror: the immutable
  // snapshot is the source of truth, so a copy is byte-identical.
  await copyTree(snapshot.worktreePath, workspace.treeDir);
  await chmod(workspace.treeDir, 0o755).catch(() => undefined);
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
      title: scenarioId,
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
  for (let index = 0; index < fields.length; ) {
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

function requireModel(deps: JobRunnerDeps): ModelHandle {
  if (deps.model === null) {
    throw new LearningError("model_not_configured", "模型尚未配置", {
      reason: "no_model",
    });
  }
  return deps.model;
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
  const model = requireModel(deps);

  const sha = await deps.snapshotService.resolve(job.repoId, payload.ref);
  checkAborted(signal);
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
    return { generationId: cached.generationId };
  }

  await prepareBuildTree(deps, job, sha, snapshot);
  checkAborted(signal);
  const workspace = deps.publisher.buildWorkspace(job.jobId);

  // Baseline (§6.4): reuse a compatible previous generation or record why not.
  let baselineFromGenerationId: GenerationId | null = null;
  let fallbackReason: string | null = null;
  const candidate = payload.baselineFromGenerationId;
  if (candidate !== null) {
    const repo = deps.repos.repos.byId(job.repoId);
    const plan = await planBaseline({
      candidate,
      targetSha: sha,
      language: "zh",
      ...(repo?.mirrorPath !== undefined
        ? { repoPath: repo.mirrorPath }
        : {}),
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

  const usageKind = usageKindFor(job);
  const metered = meteredHandle(model, {
    kind: usageKind,
    jobId: job.jobId,
    role: "repo_job",
    signal,
    gate,
    usage: deps.usage,
  });

  await deps.upstream.run({
    worktreePath: workspace.treeDir,
    mode: payload.mode,
    language: "zh",
    modelId: model.modelId,
    model: metered.chat(),
    writeRepoFiles: false,
  });
  checkAborted(signal);

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
  const result = await deps.lessons.buildResearchLessons(buildInput);
  checkAborted(signal);
  assertPublishable(result);

  const lessons = await writeLessonFiles(
    result.lessons,
    generationId,
    workspace.lessonsDir,
    deps.clock.now().toISOString(),
  );
  const manifest = await deps.publisher.seal(workspace.knowledgeDir, generationId);
  checkAborted(signal);

  const commit: PublishCommit & PublishGenerationExtras = {
    manifest,
    generationId,
    jobId: job.jobId,
    kind: "research",
    comparisonBaseSha: null,
    lessons,
    sources: sourceRows(deps, generationId),
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
  await deps.publisher.publishAtomic(commit);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  return { generationId };
}

async function runComparison(
  input: ExecuteJobInput,
): Promise<ExecuteJobResult> {
  const { deps, job, signal, gate } = input;
  const payload = job.payload as ComparisonPayload;
  const model = requireModel(deps);

  const baseSha = await deps.snapshotService.resolve(job.repoId, payload.baseSha);
  const headSha = await deps.snapshotService.resolve(job.repoId, payload.headSha);
  checkAborted(signal);
  const baseSnapshot = await deps.snapshotService.ensure(job.repoId, baseSha);
  const headSnapshot = await deps.snapshotService.ensure(job.repoId, headSha);
  const mergeBase = await mergeBaseOf(deps, job.repoId, baseSha, headSha);
  const scope = normalizeScope(payload.scope);
  const config = payload.config;
  const cacheKey = cacheKeyFor(
    deps,
    job,
    headSha,
    mergeBase,
    scope,
    config,
  );
  const generationId = generationIdFromCacheKey(cacheKey);

  const cached = deps.repos.generations.byCacheKey(cacheKey);
  if (cached !== null && cached.status === "published") {
    return { generationId: cached.generationId };
  }

  const workspace = deps.publisher.buildWorkspace(job.jobId);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  await mkdir(workspace.stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.knowledgeDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.lessonsDir, { recursive: true, mode: 0o700 });
  checkAborted(signal);

  const diff = await diffBetween(deps, job.repoId, baseSha, headSha);
  const coverage = await deps.snapshotService.coverage(
    headSnapshot,
    scope,
    generationId,
  );
  await writeCoverage(workspace.knowledgeDir, coverage);

  const usageKind = usageKindFor(job);
  const metered = meteredHandle(model, {
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
  const result = await deps.lessons.buildComparisonLesson(buildInput);
  checkAborted(signal);
  assertPublishable(result);

  const lessons = await writeLessonFiles(
    result.lessons,
    generationId,
    workspace.lessonsDir,
    deps.clock.now().toISOString(),
  );
  const manifest = await deps.publisher.seal(workspace.knowledgeDir, generationId);
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
  await deps.publisher.publishAtomic(commit);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  return { generationId };
}

async function runChange(input: ExecuteJobInput): Promise<ExecuteJobResult> {
  const { deps, job, signal, gate } = input;
  const payload = job.payload as Extract<JobRecord["payload"], { kind: "change" }>;
  const model = requireModel(deps);

  const event = deps.repos.changes.byId(payload.eventId);
  if (event === null) {
    throw new LearningError("not_found", "变更事件不存在", {
      eventId: payload.eventId,
    });
  }
  const baseSha = await deps.snapshotService.resolve(job.repoId, payload.baseSha);
  const headSha = await deps.snapshotService.resolve(job.repoId, payload.headSha);
  checkAborted(signal);
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

  const workspace = deps.publisher.buildWorkspace(job.jobId);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  await mkdir(workspace.stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.knowledgeDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace.lessonsDir, { recursive: true, mode: 0o700 });
  checkAborted(signal);

  const diff = await diffBetween(deps, job.repoId, baseSha, headSha);
  const coverage = await deps.snapshotService.coverage(
    headSnapshot,
    scope,
    generationId,
  );
  await writeCoverage(workspace.knowledgeDir, coverage);

  const metered = meteredHandle(model, {
    kind: "change",
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
  const result = await deps.lessons.buildChangeLesson(buildInput);
  checkAborted(signal);
  assertPublishable(result);

  const lessons = await writeLessonFiles(
    result.lessons,
    generationId,
    workspace.lessonsDir,
    deps.clock.now().toISOString(),
  );
  const manifest = await deps.publisher.seal(workspace.knowledgeDir, generationId);
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
  await deps.publisher.publishAtomic(commit);
  await removeBuildWorktree(deps.paths, job.jobId).catch(() => undefined);
  return { generationId };
}
