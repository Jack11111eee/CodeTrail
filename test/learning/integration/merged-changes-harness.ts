/**
 * Shared plumbing for the level-10 merge integration suites.
 *
 * The two merged branches meet in the change inbox:
 *   - `routes-changes` owns `src/learning/api/routes/changes.ts` (watch control,
 *     inbox paging, change detail) and the `static.ts` inbox projection that now
 *     imports `toChangeSummary` from it;
 *   - `gate-a` owns `scripts/phase-check.mjs` and the A gate suite.
 *
 * Everything below is the production implementation — the real HTTP core, the
 * real SQLite store, the real status quo route module, the real static-UI seam.
 * Only ports a test must control (the watch scheduler) are injected through
 * `AppDeps`, exactly the seam the production `cli.ts` uses.
 */

import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createSessionStore } from "../../../src/learning/api/auth.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { changesRoutes } from "../../../src/learning/api/routes/changes.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import {
  ensureDataDir,
  knowledgePath,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import {
  changeEventIdFromKey,
  generationIdFromCacheKey,
  jobIdFromDedupeKey,
} from "../../../src/learning/contracts/index.ts";
import type {
  AppDeps,
  ChangeEventId,
  ChangeEventPayload,
  ChangeEventState,
  ChangeLesson,
  ChangeRecord,
  Clock,
  Database,
  GenerationId,
  JobId,
  ProjectId,
  ProjectRecord,
  Repositories,
  RunningServer,
  SessionStore,
  Significance,
} from "../../../src/learning/contracts/index.ts";
import { normalizeScope } from "../../../src/learning/projects/index.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";

export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export interface ChangesHarness {
  url: string;
  paths: DataPaths;
  clock: Clock;
  db: Database;
  repos: Repositories;
  session: SessionStore;
  deps: AppDeps;
  close(): Promise<void>;
}

export interface ChangesServerOptions {
  /** Extra `AppDeps` seams (the watch scheduler in the refresh tests). */
  deps?: Record<string, unknown>;
  /** Mount the production static-UI seam on the same server. */
  ui?: boolean;
}

export async function startChangesServer(
  options: ChangesServerOptions = {},
): Promise<ChangesHarness> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);

  const db = openDatabase({ file: paths.db });
  migrate(db);
  const repos = createRepositories(db);
  const session = createSessionStore(paths);
  const clock = createClock(FIXED_NOW);
  const deps = {
    paths,
    clock,
    db,
    repos,
    session,
    model: null,
    ...options.deps,
  } as unknown as AppDeps;

  registerRouteModule(changesRoutes);
  const server: RunningServer = await createLearningServer({
    paths,
    port: 0,
    clock,
    deps,
    ui: options.ui === true ? createStaticUi(deps) : undefined,
  });

  return {
    url: server.url,
    paths,
    clock,
    db,
    repos,
    session,
    deps,
    close: () => server.close(),
  };
}

export interface SeededProject {
  projectId: ProjectId;
  repoId: ReturnType<typeof projectRepoId>;
}

function projectRepoId(name: string): ProjectRecord["repoId"] {
  return `r_${name}` as ProjectRecord["repoId"];
}

/** Inserts a repository row + project row (the production identity shape). */
export function seedProject(
  repos: Repositories,
  clock: Clock,
  name: string,
  kind: "github" | "local" = "github",
): SeededProject {
  const repoId = projectRepoId(name);
  const identity = kind === "github" ? `github:acme/${name}` : `local:/tmp/${name}`;
  repos.repos.upsert({
    repoId,
    identity,
    kind,
    mirrorPath: `/tmp/${name}.git`,
    remoteUrl: kind === "github" ? `https://github.com/acme/${name}.git` : null,
    createdAt: clock.now().toISOString(),
  });
  const projectId = `p_${name}` as ProjectId;
  repos.projects.insert({
    projectId,
    repoId,
    kind,
    displayName: name,
    remoteUrl: kind === "github" ? `https://github.com/acme/${name}.git` : null,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: clock.now().toISOString(),
    deletedAt: null,
  });
  return { projectId, repoId };
}

export interface SeedEventOptions {
  /** Makes the event key/id deterministic inside the project. */
  seq: number;
  discoveredAt?: string;
  state?: ChangeEventState;
  significance?: Significance;
  kind?: ChangeRecord["kind"];
  gapReason?: string | null;
  headSha?: string | null;
  baseSha?: string | null;
  jobId?: JobId | null;
  linkedEventId?: ChangeEventId | null;
  payload?: ChangeEventPayload;
}

export function eventIdOf(
  projectId: ProjectId,
  seq: number,
): ChangeEventId {
  return changeEventIdFromKey(`evt:${projectId}:${String(seq)}`);
}

/** Inserts one change event through the real repository. */
export function seedEvent(
  repos: Repositories,
  project: SeededProject,
  options: SeedEventOptions,
): ChangeRecord {
  const eventId = eventIdOf(project.projectId, options.seq);
  const record: ChangeRecord = {
    eventId,
    eventKey: `evt:${project.projectId}:${String(options.seq)}`,
    repoId: project.repoId,
    projectId: project.projectId,
    streamId: `default_branch:${project.repoId}`,
    streamKind: "default_branch",
    kind: options.kind ?? "commit",
    baseSha: options.baseSha === undefined ? `base-${String(options.seq)}` : options.baseSha,
    headSha: options.headSha === undefined ? `head-${String(options.seq)}` : options.headSha,
    mergeBaseSha: null,
    baseContextSha: null,
    significance: options.significance ?? "full",
    state: options.state ?? "discovered",
    jobId: options.jobId ?? null,
    gapReason: options.gapReason ?? null,
    linkedEventId: options.linkedEventId ?? null,
    linkRelation: null,
    discoveredAt: options.discoveredAt ?? "2026-01-01T00:00:00.000Z",
    publishedAt: null,
    payload: options.payload ?? {
      commit: { firstParent: null, associatedCommits: [] },
    },
  };
  repos.changes.insertMany([record]);
  return record;
}

/** A minimal but complete change lesson (the six §12.6 fields are present). */
export function changeLesson(
  generationId: GenerationId,
  eventId: ChangeEventId,
  overrides: Partial<ChangeLesson> = {},
): ChangeLesson {
  return {
    lessonId: `l_${generationId}` as ChangeLesson["lessonId"],
    generationId,
    kind: "change",
    eventId,
    context: {
      repoId: "r_seed",
      commitSha: "head-1",
      generationId,
      scenarioId: "sc_change",
      moduleIds: ["src"],
    },
    scenario: {
      id: "sc_change",
      kind: "library_interface",
      inputs: [],
      userAction: "调用",
      observableResult: "返回",
      isExample: true,
    },
    overview: [],
    plainExplanation: [],
    technicalExplanation: [],
    choices: [],
    choicesOmittedReason: null,
    boundaries: [],
    statements: [],
    evidence: [],
    diagram: {
      kind: "component",
      mermaid: "flowchart LR",
      nodes: [],
      edges: [],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
    behaviorChange: { before: "旧行为", after: "新行为" },
    affectedModules: [{ moduleId: "src", effect: "改变导出值" }],
    keyTechnologies: ["TypeScript"],
    alternatives: [],
    unverifiedEffects: ["运行时行为未经测试"],
    omittedReasons: {},
    ...overrides,
  } as unknown as ChangeLesson;
}

export interface SeedGenerationOptions {
  /** Skip the `jobs` row, exercising the `generations.job_id` fallback. */
  skipJob?: boolean;
  /** Status written to the generation row (default `published`). */
  status?: "staged" | "published" | "failed" | "superseded";
  /** Write the lesson file under a different (possibly hostile) relPath. */
  relPath?: string;
  /** Do not write a lesson file at all. */
  omitFile?: boolean;
  /** Raw file contents, for the malformed-file case. */
  fileContents?: string;
  lesson?: ChangeLesson;
}

export interface SeededGeneration {
  generationId: GenerationId;
  jobId: JobId;
  lessonId: ChangeLesson["lessonId"];
  knowledgeDir: string;
}

/**
 * Writes a change generation + lesson row + lesson file, then points the event
 * at the job. This is the shape `Publisher` produces, without running a model.
 */
export async function seedChangeGeneration(
  harness: ChangesHarness,
  project: SeededProject,
  event: ChangeRecord,
  options: SeedGenerationOptions = {},
): Promise<SeededGeneration> {
  const generationId = generationIdFromCacheKey(`cache:${event.eventKey}`);
  const jobId = jobIdFromDedupeKey(`dedupe:${event.eventKey}`);
  const at = harness.clock.now().toISOString();
  const lesson = options.lesson ?? changeLesson(generationId, event.eventId);
  const knowledgeDir = knowledgePath(harness.paths, generationId);
  const relPath = options.relPath ?? `lessons/${lesson.lessonId}.json`;
  const file = path.join(knowledgeDir, relPath);
  const fileContents =
    options.fileContents ?? `${JSON.stringify(lesson, null, 2)}\n`;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, fileContents, "utf8");

  if (options.skipJob !== true) {
    harness.repos.jobs.insert({
      jobId,
      dedupeKey: `dedupe:${event.eventKey}`,
      kind: "change_analysis",
      repoId: project.repoId,
      projectId: project.projectId,
      streamId: event.streamId,
      state: "completed",
      payload: {
        kind: "change",
        eventId: event.eventId,
        baseSha: event.baseSha ?? "base",
        headSha: event.headSha ?? "head",
        mergeBaseSha: event.mergeBaseSha ?? "base",
        streamKind: event.streamKind,
      },
      attempt: 0,
      errorCode: null,
      errorDetail: null,
      progress: null,
      outputGenerationId: generationId,
      createdAt: at,
      startedAt: at,
      finishedAt: at,
    });
  }

  harness.repos.generations.insertPublished({
    generationId,
    cacheKey: `cache:${event.eventKey}`,
    repoId: project.repoId,
    projectId: project.projectId,
    commitSha: event.headSha ?? "head",
    comparisonBaseSha: null,
    kind: "change",
    scopeHash: "scope:seed",
    configHash: "config:seed",
    promptTemplateVersion: "prompt",
    preferencesVersion: 1,
    upstreamVersion: "upstream",
    status: options.status ?? "published",
    contentDir: knowledgeDir,
    sealedTreeHash: "sha256:tree",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId,
    createdAt: at,
    publishedAt: options.status === "staged" ? null : at,
  });

  if (options.omitFile !== true) {
    harness.repos.lessons.insertMany([
      {
        lessonId: lesson.lessonId,
        generationId,
        kind: "change",
        title: "变更讲解",
        relPath,
        jsonSha256: "sha256:lesson",
        publishedAt: at,
      },
    ]);
  }

  harness.repos.changes.setState(event.eventId, "published", {
    jobId,
    publishedAt: at,
  });
  return { generationId, jobId, lessonId: lesson.lessonId, knowledgeDir };
}

/** Counts `*.test.ts` files under a directory (used by the gate registry test). */
export function containsTestFile(directory: string): boolean {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (containsTestFile(absolute)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}
