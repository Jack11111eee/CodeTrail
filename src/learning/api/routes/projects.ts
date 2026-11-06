import { latestProjectJob } from "../jobs/project-job.js";
/**
 * Project routes: import, list/detail, dependents, confirmed removal and the
 * two analysis submissions (architecture §5, §7.2, §7.5, §14.1, §3.8).
 *
 * `POST /api/projects` is the **only** entry point that accepts an absolute
 * filesystem path (AC-PRJ-03). Every other handler receives opaque ids and
 * refs; refs are resolved through the mirror, never treated as paths.
 *
 * Every project-scoped handler calls {@link assertProjectActive} before doing
 * work, so a removed project answers `410 source_removed` and a missing one
 * `404 not_found` — the same decision the UI needs in order to render "不可用"
 * rather than "不存在" (§5.8).
 *
 * Submission is intentionally thin: resolve the ref, materialise the snapshot,
 * compute the normalized scope/config and hand a deterministic
 * `EnqueueJobInput` to the `JobRunner`. The runner owns deduplication and the
 * cache-hit path, so two identical submissions return one `jobId` and one
 * `jobs` row (AC-API-09), and a changed scope hashes to a new one (§7.2).
 */

import fs from "node:fs";
import path from "node:path";

import { LearningError, errorMessageFor } from "../../contracts/index.js";
import {
  assertProjectActive,
  changeEventIdFromKey,
  computeCacheKey,
  computeConfigHash,
  computeEventKey,
  generationIdFromCacheKey,
  newProjectId,
} from "../../contracts/index.js";
import type {
  AppDeps,
  ChangeEventId,
  CreateAnalysisRequest,
  CreateAnalysisResponse,
  CreateComparisonRequest,
  CreateComparisonResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CoverageReport,
  DeleteProjectResponse,
  DependentsView,
  EnqueueJobInput,
  GenerationConfig,
  GenerationId,
  GenerationPayload,
  HandlerFactory,
  JobRecord,
  JobState,
  ProjectDetail,
  ProjectDependents,
  ProjectId,
  ProjectListView,
  ProjectRecord,
  ProjectSummary,
  RemovalService,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
} from "../../contracts/index.js";
import {
  LESSON_PIPELINE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../config/defaults.js";
import { loadCredential } from "../../config/credentials.js";
import {
  cloneMirror,
  fetchMirror,
  createRemovalService,
  displayNameOf,
  git,
  githubIdentity,
  localIdentity,
  normalizeGithubUrl,
  normalizeScope,
} from "../../projects/index.js";
import type { MirrorHandle } from "../../projects/index.js";

export const routes: readonly RouteDef[] = [
  {
    method: "POST",
    pattern: "/api/projects",
    auth: "session",
    handler: "projects.create",
  },
  {
    method: "GET",
    pattern: "/api/projects",
    auth: "session",
    handler: "projects.list",
  },
  {
    method: "GET",
    pattern: "/api/projects/:id",
    auth: "session",
    handler: "projects.get",
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/dependents",
    auth: "session",
    handler: "projects.dependents",
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:id",
    auth: "session",
    handler: "projects.delete",
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/analyses",
    auth: "session",
    handler: "analyses.create",
  },
  {
    method: "POST",
    pattern: "/api/projects/:id/comparisons",
    auth: "session",
    handler: "comparisons.create",
  },
];

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DONE_STATE: JobState = "completed";

// ── shared helpers (also consumed by the sibling route modules) ─────────────

/**
 * Returns the injected removal service, or builds one from the deps this
 * revision of `AppDeps` necessarily has. `AppDeps` is the only DI root, so a
 * route never reaches for a singleton.
 */
export function removalServiceFor(deps: AppDeps): RemovalService {
  if (deps.removal !== undefined) return deps.removal;
  return createRemovalService({
    db: deps.db,
    repos: deps.repos,
    clock: deps.clock,
    jobs: deps.jobRunner,
  });
}

/**
 * Loads a project and asserts it is active. `assertProjectActive` runs first,
 * so a removed project is a 410 and an unknown id a 404; the row lookup that
 * follows can never be a redirect to a newer project.
 */
export function requireActiveProject(
  deps: AppDeps,
  projectId: ProjectId,
): ProjectRecord {
  const state = removalServiceFor(deps).state(projectId);
  assertProjectActive(state, projectId);
  const project = deps.repos.projects.byId(projectId);
  if (project === null) {
    throw new LearningError("not_found", errorMessageFor("not_found", "zh"), {
      projectId,
    });
  }
  return project;
}

/** Absolute knowledge directory for a generation row. */
export function generationKnowledgeDir(
  deps: AppDeps,
  contentDir: string,
): string {
  return path.isAbsolute(contentDir)
    ? contentDir
    : path.join(deps.paths.knowledge, contentDir);
}

/**
 * Reads the sealed `coverage.json`. A missing or malformed report is reported
 * as *incomplete*, never as complete: `complete === (gaps.length === 0)` is
 * the invariant (AC-PRJ-16).
 */
export function readCoverageReport(
  deps: AppDeps,
  generationId: GenerationId,
  contentDir: string,
  commitSha: string,
): CoverageReport {
  let raw: unknown = null;
  try {
    raw = JSON.parse(
      fs.readFileSync(
        path.join(generationKnowledgeDir(deps, contentDir), "coverage.json"),
        "utf8",
      ),
    ) as unknown;
  } catch {
    // A missing or malformed report is handled below as "incomplete".
  }
  if (typeof raw !== "object" || raw === null) {
    return {
      generationId,
      commitSha,
      complete: false,
      analyzed: [],
      gaps: [],
      counts: { totalFiles: 0, analyzedFiles: 0, excludedFiles: 0 },
      languages: { byLanguage: [], preferredCoverageOk: false },
    };
  }
  const candidate = raw as Partial<CoverageReport>;
  const analyzed = Array.isArray(candidate.analyzed) ? candidate.analyzed : [];
  const gaps = Array.isArray(candidate.gaps) ? candidate.gaps : [];
  return {
    generationId,
    commitSha,
    complete: candidate.complete === true && gaps.length === 0,
    analyzed,
    gaps,
    counts: candidate.counts ?? {
      totalFiles: analyzed.length + gaps.length,
      analyzedFiles: analyzed.length,
      excludedFiles: gaps.length,
    },
    languages: candidate.languages ?? {
      byLanguage: [],
      preferredCoverageOk: false,
    },
  };
}

/** Projects a stored row plus its latest successful research generation. */
export function toProjectSummary(
  deps: AppDeps,
  project: ProjectRecord,
): ProjectSummary {
  const generation = deps.repos.generations.latestPublished(project.repoId, {
    kind: "research",
  });
  const job = latestProjectJob(deps.repos, project);
  return {
    generationId: generation?.generationId ?? null,
    latestJobId: job?.jobId ?? null,
    latestJobResumeAvailable: job?.progress?.resumeAvailable === true,
    projectId: project.projectId,
    repoId: project.repoId,
    kind: project.kind,
    displayName: project.displayName,
    defaultBranch: project.defaultBranch,
    analyzedCommitSha: generation?.commitSha ?? null,
    lastSuccessAt: generation?.publishedAt ?? null,
    latestJobState: job?.state ?? null,
    watchEnabled: project.watchEnabled,
  };
}

export function toDependentsView(
  projectId: ProjectId,
  dependents: ProjectDependents,
): DependentsView {
  return {
    projectId,
    conversations: {
      ids: [...dependents.conversations],
      count: dependents.conversations.length,
    },
    lessons: { ids: [...dependents.lessons], count: dependents.lessons.length },
    generations: {
      ids: [...dependents.generations],
      count: dependents.generations.length,
    },
    changeEvents: {
      ids: [...dependents.changeEvents],
      count: dependents.changeEvents.length,
    },
  };
}

// ── import ──────────────────────────────────────────────────────────────────

/**
 * The clone URL for a GitHub identity.
 *
 * Production clones from `github.com`. When a test (or an enterprise proxy)
 * points `CODETRAIL_GITHUB_API_BASE_URL` at a loopback fake, the same origin
 * serves the repository over Git smart HTTP, so an offline import exercises the
 * real clone path instead of a pre-seeded mirror.
 */
export function githubCloneUrl(owner: string, repo: string): string {
  const configured = process.env.CODETRAIL_GITHUB_API_BASE_URL?.trim();
  if (
    configured !== undefined &&
    configured !== "" &&
    configured !== DEFAULT_GITHUB_API_BASE_URL
  ) {
    try {
      const base = new URL(configured);
      if (base.protocol === "http:" || base.protocol === "https:") {
        return `${base.origin}/${owner}/${repo}.git`;
      }
    } catch {
      // Fall through to the public host: an unparseable override must not make
      // import impossible.
    }
  }
  return `https://github.com/${owner}/${repo}.git`;
}

async function defaultBranchOf(handle: MirrorHandle): Promise<string | null> {
  const result = await git(handle.path, ["symbolic-ref", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== "" ? branch : null;
}

const createProject: HandlerFactory = (deps) => async (req) => {
  const body = req.body as CreateProjectRequest;
  const now = deps.clock.now().toISOString();

  let identity: ReturnType<typeof localIdentity>;
  let handle: MirrorHandle;
  let kind: "local" | "github";
  let remoteUrl: string | null;

  if ("localPath" in body) {
    // The one and only absolute-path boundary (AC-PRJ-03).
    identity = localIdentity(body.localPath);
    handle = await cloneMirror(deps.paths, identity, {
      localPath: body.localPath,
    });
    kind = "local";
    remoteUrl = null;
  } else {
    const normalized = normalizeGithubUrl(body.githubUrl);
    identity = githubIdentity(normalized.owner, normalized.repo);
    const credential = loadCredential(deps.paths, process.env);
    handle = await cloneMirror(deps.paths, identity, {
      remoteUrl: githubCloneUrl(normalized.owner, normalized.repo),
      credential,
    });
    kind = "github";
    remoteUrl = normalized.url;
  }

  const repo = deps.repos.repos.upsert({
    repoId: handle.repoId,
    identity,
    kind,
    mirrorPath: handle.path,
    remoteUrl,
    createdAt: now,
  });

  const projectId = newProjectId();
  deps.repos.projects.insert({
    projectId,
    repoId: repo.repoId,
    kind,
    displayName: displayNameOf(identity),
    remoteUrl,
    defaultBranch: await defaultBranchOf(handle),
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: now,
    deletedAt: null,
  });

  const response: CreateProjectResponse = {
    projectId,
    repoId: repo.repoId,
  };
  return { kind: "json", status: 201, body: response };
};

// ── list / detail / dependents / delete ─────────────────────────────────────

const listProjects: HandlerFactory = (deps) => () => {
  const body: ProjectListView = {
    projects: deps.repos.projects
      .list()
      .map((project) => toProjectSummary(deps, project)),
  };
  return Promise.resolve({ kind: "json", status: 200, body });
};

function projectDetail(deps: AppDeps, project: ProjectRecord): ProjectDetail {
  const generation = deps.repos.generations.latestPublished(project.repoId, {
    kind: "research",
  });
  let coverage = { complete: false, gapCount: 0 };
  if (generation !== null) {
    const report = readCoverageReport(
      deps,
      generation.generationId,
      generation.contentDir,
      generation.commitSha,
    );
    coverage = { complete: report.complete, gapCount: report.gaps.length };
  }
  return {
    ...toProjectSummary(deps, project),
    remoteUrl: project.remoteUrl,
    coverage,
    lastPollAt: deps.watch?.lastPollAt(project.projectId) ?? null,
    generationCount: deps.repos.generations.listByProject(project.projectId)
      .length,
  };
}

const getProject: HandlerFactory = (deps) => (req) => {
  const project = requireActiveProject(deps, req.params.id as ProjectId);
  return Promise.resolve({
    kind: "json",
    status: 200,
    body: projectDetail(deps, project),
  });
};

const getDependents: HandlerFactory = (deps) => async (req) => {
  const projectId = req.params.id as ProjectId;
  requireActiveProject(deps, projectId);
  const dependents = await removalServiceFor(deps).dependents(projectId);
  const body: DependentsView = toDependentsView(projectId, dependents);
  return { kind: "json", status: 200, body };
};

const deleteProject: HandlerFactory = (deps) => async (req) => {
  const projectId = req.params.id as ProjectId;
  // `confirm` is interpreted by `RemovalService.remove`, which returns
  // `invalid_input`/`confirm_required` before writing anything (AC-PRJ-14).
  const dependents = await removalServiceFor(deps).remove(
    projectId,
    req.query.confirm === "true",
  );
  const body: DeleteProjectResponse = {
    removed: true,
    dependents: toDependentsView(projectId, dependents),
  };
  return { kind: "json", status: 200, body };
};

// ── analysis / comparison submission ────────────────────────────────────────

/** Rejects a ref that is really a client-supplied filesystem path (AC-PRJ-03). */
export function assertNotPathLike(value: string, field: string): void {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("\0") ||
    value.split(/[\\/]+/u).includes("..")
  ) {
    throw new LearningError(
      "out_of_scope_path",
      errorMessageFor("out_of_scope_path", "zh"),
      { field, value },
    );
  }
}

function defaultGenerationConfig(deps: AppDeps): GenerationConfig {
  const settings = deps.model?.settings ?? deps.repos.settings.model();
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

export function mergeGenerationConfig(
  deps: AppDeps,
  patch: Partial<GenerationConfig> | undefined,
): GenerationConfig {
  const base = defaultGenerationConfig(deps);
  if (patch === undefined) return base;
  return {
    ...base,
    ...patch,
    language: "zh",
    model: patch.model ?? base.model,
    externalDocs: patch.externalDocs ?? base.externalDocs,
  };
}

function requireModel(deps: AppDeps): void {
  if (deps.model === null) {
    throw new LearningError("model_not_configured", "模型尚未配置", {
      reason: "no_model",
    });
  }
}

function cacheKeyFor(
  deps: AppDeps,
  repoId: ProjectRecord["repoId"],
  commitSha: string,
  baseContextSha: string | null,
  scopeHash: string,
  config: GenerationConfig,
  comparisonBaseSha: string | null = null,
): string {
  const repo = deps.repos.repos.byId(repoId);
  return computeCacheKey({
    kind: comparisonBaseSha === null ? "research" : "comparison",
    comparisonBaseSha,
    repoIdentity: repo?.identity ?? `local:${deps.paths.root}`,
    targetCommitSha: commitSha,
    baseContextSha,
    scopeHash,
    generationConfigHash: computeConfigHash(config),
    promptTemplateVersion: config.promptTemplateVersion,
    preferencesVersion: deps.repos.prefs.version(),
    upstreamVersion: UPSTREAM_VERSION,
  });
}

function analysisInput(
  deps: AppDeps,
  project: ProjectRecord,
  body: CreateAnalysisRequest,
  commitSha: string,
  scopeHash: string,
  config: GenerationConfig,
  baselineFromGenerationId: GenerationId | null,
): EnqueueJobInput {
  const mode = baselineFromGenerationId === null ? "init" : "update";
  const payload: GenerationPayload = {
    kind: "generation",
    mode,
    ref: body.ref,
    commitSha,
    baseContextSha: null,
    scope: { ...normalizeScope(body.scope), hash: scopeHash },
    config,
    baselineFromGenerationId,
  };
  return {
    kind: mode === "init" ? "generation_initial" : "generation_update",
    repoId: project.repoId,
    projectId: project.projectId,
    streamId: null,
    comparisonBaseSha: null,
    headSha: commitSha,
    baseContextSha: null,
    scopeHash,
    analysisConfigHash: computeConfigHash(config),
    payload,
  };
}

const createAnalysis: HandlerFactory = (deps) => async (req) => {
  const project = requireActiveProject(deps, req.params.id as ProjectId);
  const body = req.body as CreateAnalysisRequest;
  assertNotPathLike(body.ref, "ref");
  requireModel(deps);

  const repo = deps.repos.repos.byId(project.repoId);
  if (repo && project.kind === "local" && repo.identity.startsWith("local:")) {
    await fetchMirror(deps.paths, project.repoId, {
      remoteUrl: repo.identity.slice(6),
      refspecs: ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
    });
  }
  const commitSha = await deps.snapshotService.resolve(
    project.repoId,
    body.ref,
  );
  await deps.snapshotService.ensure(project.repoId, commitSha);

  const scope = normalizeScope(body.scope);
  const config = mergeGenerationConfig(deps, body.config);
  const previous = deps.repos.generations.latestPublished(project.repoId, {
    kind: "research",
  });
  const baselineFromGenerationId = previous?.generationId ?? null;

  const input = analysisInput(
    deps,
    project,
    body,
    commitSha,
    scope.hash,
    config,
    baselineFromGenerationId,
  );
  const job = await deps.jobRunner.enqueue(input);
  const generationId =
    job.outputGenerationId ??
    generationIdFromCacheKey(
      cacheKeyFor(deps, project.repoId, commitSha, null, scope.hash, config),
    );

  const response: CreateAnalysisResponse = {
    jobId: job.jobId,
    generationId,
    cacheHit: job.state === DONE_STATE && job.outputGenerationId !== null,
  };
  return { kind: "json", status: 202, body: response };
};

async function mergeBaseOf(
  deps: AppDeps,
  project: ProjectRecord,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const repo = deps.repos.repos.byId(project.repoId);
  if (repo === null) return baseSha;
  const result = await git(repo.mirrorPath, ["merge-base", baseSha, headSha]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/u.test(sha) ? sha : baseSha;
}

const createComparison: HandlerFactory = (deps) => async (req) => {
  const project = requireActiveProject(deps, req.params.id as ProjectId);
  const body = req.body as CreateComparisonRequest;
  assertNotPathLike(body.baseSha, "baseSha");
  assertNotPathLike(body.headSha, "headSha");
  requireModel(deps);

  const baseSha = await deps.snapshotService.resolve(
    project.repoId,
    body.baseSha,
  );
  const headSha = await deps.snapshotService.resolve(
    project.repoId,
    body.headSha,
  );
  await deps.snapshotService.ensure(project.repoId, baseSha);
  await deps.snapshotService.ensure(project.repoId, headSha);

  const mergeBase = await mergeBaseOf(deps, project, baseSha, headSha);
  const scope = normalizeScope(body.scope);
  const config = mergeGenerationConfig(deps, body.config);
  const streamId = `cmp:${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`;

  const input: EnqueueJobInput = {
    kind: "comparison",
    repoId: project.repoId,
    projectId: project.projectId,
    streamId,
    comparisonBaseSha: baseSha,
    headSha,
    baseContextSha: mergeBase,
    scopeHash: scope.hash,
    analysisConfigHash: computeConfigHash(config),
    payload: {
      kind: "comparison",
      baseSha,
      headSha,
      scope: { ...scope, hash: scope.hash },
      config,
    },
  };
  const job = await deps.jobRunner.enqueue(input);
  recordComparisonEvent(deps, project, job, {
    baseSha,
    headSha,
    mergeBase,
    streamId,
  });

  const generationId =
    job.outputGenerationId ??
    generationIdFromCacheKey(
      cacheKeyFor(
        deps,
        project.repoId,
        headSha,
        mergeBase,
        scope.hash,
        config,
        baseSha,
      ),
    );

  const response: CreateComparisonResponse = {
    jobId: job.jobId,
    generationId,
  };
  return { kind: "json", status: 202, body: response };
};

/**
 * A comparison is an inbox event as well as a job (AC-PRJ-13). The event is
 * keyed deterministically on the stream, so an identical submission reuses it;
 * a cache-hit job is already published, and a fresh one starts `queued`.
 */
function recordComparisonEvent(
  deps: AppDeps,
  project: ProjectRecord,
  job: JobRecord,
  i: {
    baseSha: string;
    headSha: string;
    mergeBase: string;
    streamId: string;
  },
): void {
  const eventKey = computeEventKey({
    repoId: project.repoId,
    streamId: i.streamId,
    kind: "comparison",
    baseSha: i.baseSha,
    headSha: i.headSha,
    mergeBaseSha: i.mergeBase,
    baseContextSha: i.mergeBase,
  });
  const eventId: ChangeEventId = changeEventIdFromKey(eventKey);
  if (deps.repos.changes.byId(eventId) !== null) return;

  const published = job.state === DONE_STATE;
  const now = deps.clock.now().toISOString();
  deps.repos.changes.insertMany([
    {
      eventId,
      eventKey,
      repoId: project.repoId,
      projectId: project.projectId,
      streamId: i.streamId,
      streamKind: "comparison",
      kind: "comparison",
      baseSha: i.baseSha,
      headSha: i.headSha,
      mergeBaseSha: i.mergeBase,
      baseContextSha: i.mergeBase,
      significance: "full",
      state: published ? "published" : "queued",
      jobId: job.jobId,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: now,
      publishedAt: published ? now : null,
      payload: { comparison: { baseSha: i.baseSha, headSha: i.headSha } },
    },
  ]);
}

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "projects.create": createProject,
  "projects.list": listProjects,
  "projects.get": getProject,
  "projects.dependents": getDependents,
  "projects.delete": deleteProject,
  "analyses.create": createAnalysis,
  "comparisons.create": createComparison,
};

export const projectsRoutes: RouteModule = {
  id: "projects",
  routes,
  handlers,
};
