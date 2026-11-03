/* eslint-disable @typescript-eslint/require-await, require-yield -- the stubs implement async ports synchronously */
/**
 * HTTP harness for the project/job/generation route suites.
 *
 * The HTTP core, SQLite repositories, snapshot service, job runner, publisher
 * and removal service are the production implementations. Only the seams a
 * test must control are stubbed: the upstream generation port (writes a tiny
 * deterministic wiki), the lesson builder (one lesson with one repo source),
 * and the model (never invoked because both stubs ignore it).
 *
 * That keeps the suite honest: import really clones, analysis really resolves
 * a ref and creates a snapshot, submission really enqueues and publishes, and
 * removal really writes the soft-delete row.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createSessionStore, SESSION_COOKIE } from "../../../src/learning/api/auth.ts";
import { createPublisher } from "../../../src/learning/api/jobs/publish.ts";
import { createJobRunner } from "../../../src/learning/api/jobs/runner.ts";
import { createUsageMeter } from "../../../src/learning/api/jobs/usage.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import { generationsRoutes } from "../../../src/learning/api/routes/generations.ts";
import { jobsRoutes } from "../../../src/learning/api/routes/jobs.ts";
import { projectsRoutes } from "../../../src/learning/api/routes/projects.ts";
import {
  ensureDataDir,
  knowledgePath,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import type {
  AppDeps,
  ChatModelLike,
  Clock,
  ConversationService,
  CoverageReport,
  Database,
  ExternalDocService,
  JobRunner,
  LessonBuilderPort,
  LessonId,
  ModelHandle,
  NormalizedScope,
  Repositories,
  RouteModule,
  RunningServer,
  SessionStore,
  SnapshotReader,
  SnapshotService,
  UpstreamGenerationPort,
} from "../../../src/learning/contracts/index.ts";
import { newLessonId } from "../../../src/learning/contracts/index.ts";
import { createSourceRegistry } from "../../../src/learning/evidence/registry.ts";
import { createRemovalService } from "../../../src/learning/projects/removal.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";
import type { AnyLesson } from "../../../src/learning/lessons/index.ts";

export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export interface RoutesHarness {
  url: string;
  port: number;
  paths: DataPaths;
  clock: Clock;
  db: Database;
  repos: Repositories;
  session: SessionStore;
  deps: AppDeps;
  jobRunner: JobRunner;
  cookie: Record<string, string>;
  close(): Promise<void>;
}

function readdirSafe(directory: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Snapshots are read-only; restore write bits so the temp dir can be removed. */
function makeWritableSync(root: string): void {
  for (const entry of readdirSafe(root)) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeWritableSync(child);
      chmodSync(child, 0o755);
    } else if (entry.isFile()) {
      chmodSync(child, 0o644);
    }
  }
  try {
    chmodSync(root, 0o755);
  } catch {
    // Already gone.
  }
}

function sampleLesson(
  kind: "research" | "change" | "comparison",
  generation: { generationId: string; repoId: string; commitSha: string },
  sourceIds: readonly string[],
  context: Record<string, unknown>,
): AnyLesson {
  return {
    lessonId: newLessonId(`${generation.generationId}:${kind}`),
    generationId: generation.generationId,
    kind,
    context,
    scenario: {
      id: "sc_test",
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
    evidence: [...sourceIds],
    diagram: {
      kind: "component",
      mermaid: "flowchart LR",
      nodes: [],
      edges: [],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
  } as unknown as AnyLesson;
}

async function firstFile(
  snapshot: SnapshotReader,
  scope: NormalizedScope,
): Promise<string> {
  const files = await snapshot.list(scope);
  return files[0]?.path ?? "README.md";
}

const stubUpstream: UpstreamGenerationPort = {
  async run(request) {
    const wiki = path.join(request.worktreePath, "openwiki");
    await mkdir(path.join(wiki, ".claims"), { recursive: true });
    await writeFile(path.join(wiki, "quickstart.md"), "# Quickstart\n", "utf8");
    await writeFile(
      path.join(wiki, ".page-manifest.json"),
      JSON.stringify({ schemaVersion: 1, pages: {} }),
      "utf8",
    );
    await writeFile(
      path.join(wiki, ".claims", "quickstart.json"),
      JSON.stringify({ schemaVersion: 1, claims: [] }),
      "utf8",
    );
    return { skipped: false, sourceChanged: true };
  },
  async sourceFingerprint() {
    return "fingerprint";
  },
  async treeHashOfWorktree() {
    return "tree";
  },
  async changedPaths() {
    return [];
  },
  async lastUpdate() {
    return null;
  },
  async pageManifest() {
    return null;
  },
};

const stubLessons: LessonBuilderPort = {
  async buildResearchLessons(input) {
    const file = await firstFile(input.snapshot, input.scope);
    const ref = await input.registry.registerRepo({
      generationId: input.generation.generationId,
      repoId: input.generation.repoId,
      commitSha: input.generation.commitSha,
      path: file,
      lines: null,
      snapshot: input.snapshot,
      scope: input.scope,
    });
    return {
      lessons: [
        sampleLesson("research", input.generation, [ref.sourceId], {
          repoId: input.generation.repoId,
          commitSha: input.generation.commitSha,
          generationId: input.generation.generationId,
          scenarioId: "sc_test",
          moduleIds: ["src"],
        }),
      ],
      failures: [],
      blankTeaching: false,
    };
  },
  async buildChangeLesson(input) {
    const file = await firstFile(input.headSnapshot, input.scope);
    const ref = await input.registry.registerRepo({
      generationId: input.generation.generationId,
      repoId: input.generation.repoId,
      commitSha: input.generation.commitSha,
      path: file,
      lines: null,
      snapshot: input.headSnapshot,
      scope: input.scope,
    });
    const lesson = sampleLesson("change", input.generation, [ref.sourceId], {
      repoId: input.generation.repoId,
      commitSha: input.generation.commitSha,
      generationId: input.generation.generationId,
      scenarioId: "sc_test",
      moduleIds: ["src"],
    }) as unknown as Record<string, unknown>;
    lesson.eventId = input.event.eventId;
    lesson.behaviorChange = { before: "before", after: "after" };
    lesson.affectedModules = [];
    lesson.keyTechnologies = [];
    lesson.alternatives = [];
    lesson.unverifiedEffects = [];
    lesson.omittedReasons = {};
    return {
      lessons: [lesson as unknown as AnyLesson],
      failures: [],
      blankTeaching: false,
    };
  },
  async buildComparisonLesson(input) {
    const headFile = await firstFile(input.headSnapshot, input.scope);
    const baseFile = await firstFile(input.baseSnapshot, input.scope);
    const head = await input.registry.registerRepo({
      generationId: input.generation.generationId,
      repoId: input.head.repoId,
      commitSha: input.head.commitSha,
      path: headFile,
      lines: null,
      snapshot: input.headSnapshot,
      scope: input.scope,
    });
    const base = await input.registry.registerRepo({
      generationId: input.generation.generationId,
      repoId: input.base.repoId,
      commitSha: input.base.commitSha,
      path: baseFile,
      lines: null,
      snapshot: input.baseSnapshot,
      scope: input.scope,
    });
    const lesson = sampleLesson(
      "comparison",
      input.generation,
      [head.sourceId, base.sourceId],
      {
        repoId: input.generation.repoId,
        commitSha: input.head.commitSha,
        generationId: input.generation.generationId,
        scenarioId: "sc_test",
        moduleIds: ["src"],
        comparison: {
          base: {
            repoId: input.base.repoId,
            commitSha: input.base.commitSha,
            generationId: input.base.generationId,
          },
          head: {
            repoId: input.head.repoId,
            commitSha: input.head.commitSha,
            generationId: input.head.generationId,
          },
        },
      },
    ) as unknown as Record<string, unknown>;
    lesson.baseGenerationId = null;
    lesson.headGenerationId = null;
    return {
      lessons: [lesson as unknown as AnyLesson],
      failures: [],
      blankTeaching: false,
    };
  },
};

const stubExternal: ExternalDocService = {
  async fetchExact() {
    return { ok: false, status: "source_missing", reason: "not_found" };
  },
  async cached() {
    return null;
  },
};

function stubModel(): ModelHandle {
  return {
    modelId: "stub",
    settings: {
      provider: "stub",
      model: "stub",
      maxOutputTokens: 1024,
      temperature: 0,
      pricing: null,
      quota: {
        maxCalls: 1_000,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
      },
    },
    chat: () => ({}) as ChatModelLike,
    estimate: () => ({ calls: 1, tokens: 10 }),
  };
}

const stubConversations = {
  async create() {
    throw new Error("not used by these route suites");
  },
  async get() {
    return null;
  },
  async appendUserMessage() {
    throw new Error("not used by these route suites");
  },
  appendAssistantDelta() {
    throw new Error("not used by these route suites");
  },
  async setAnswerPhase() {
    throw new Error("not used by these route suites");
  },
  async finalizeMessage() {
    throw new Error("not used by these route suites");
  },
  async addSelection() {
    throw new Error("not used by these route suites");
  },
} as unknown as ConversationService;

export interface RoutesHarnessOptions {
  /** Additional modules (a sibling stand-in or a deliberately narrow module). */
  extraModules?: RouteModule[];
  /** Replace the model (e.g. `null` for the unconfigured-model case). */
  model?: ModelHandle | null;
}

/**
 * Starts a real learning server with the three route modules owned by this
 * issue. `test/learning/projects/task-data-dir.ts` supplies an isolated
 * `CODETRAIL_DATA_DIR` per test.
 */
export async function startRoutesHarness(
  options: RoutesHarnessOptions = {},
): Promise<RoutesHarness> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);

  const clock = createClock(FIXED_NOW);
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  const repos = createRepositories(db);
  const session = createSessionStore(paths);

  const snapshotService: SnapshotService = createSnapshotService({
    paths,
    repos,
    clock,
  });
  const publisher = createPublisher({ paths, db, repos, clock });
  const registry = createSourceRegistry({
    clock,
    sources: repos.sources,
    generations: repos.generations,
  });
  const usage = createUsageMeter({ db, repos, clock });

  const jobRunner = createJobRunner({
    db,
    repos,
    paths,
    clock,
    snapshotService,
    publisher,
    upstream: stubUpstream,
    lessons: stubLessons,
    model: stubModel(),
    usage,
    registry,
    external: stubExternal,
  });

  const removal = createRemovalService({
    db,
    repos,
    clock,
    jobs: jobRunner,
  });

  const deps = {
    paths,
    clock,
    db,
    repos,
    jobRunner,
    publisher,
    watch: {
      start() {},
      stop() {},
      async runTick() {
        return [];
      },
      lastPollAt() {
        return null;
      },
    },
    snapshotService,
    retriever: {
      async search() {
        return [];
      },
    },
    conversations: stubConversations,
    answers: {
      async *answer() {
        throw new Error("not used by these route suites");
      },
    },
    registry,
    external: stubExternal,
    model: options.model === undefined ? stubModel() : options.model,
    session,
    removal,
    usage,
  } as unknown as AppDeps;

  for (const module of [
    projectsRoutes,
    jobsRoutes,
    generationsRoutes,
    ...(options.extraModules ?? []),
  ]) {
    registerRouteModule(module);
  }

  const server: RunningServer = await createLearningServer({
    paths,
    port: 0,
    clock,
    deps,
  });
  const token = await session.ensureToken();

  return {
    url: server.url,
    port: server.port,
    paths,
    clock,
    db,
    repos,
    session,
    deps,
    jobRunner,
    cookie: { Cookie: `${SESSION_COOKIE}=${token}` },
    async close() {
      // Let any in-flight job finish before the database connection closes; a
      // half-run job after `db.close()` would surface as an unhandled
      // rejection and could hide a real failure.
      await jobRunner.drain().catch(() => undefined);
      await server.close();
      makeWritableSync(paths.root);
      db.close();
    },
  };
}

/** Writes a published generation and its sealed knowledge dir for read tests. */
export async function seedPublishedGeneration(
  harness: RoutesHarness,
  i: {
    generationId: string;
    repoId: string;
    projectId?: string | null;
    commitSha: string;
    lessonId?: string;
    lessonTitle?: string;
    sourceId?: string;
    sourcePath?: string;
    sourceCommitSha?: string;
    coverage?: CoverageReport;
  },
): Promise<{ knowledgeDir: string }> {
  const knowledgeDir = knowledgePath(
    harness.paths,
    i.generationId as never,
  );
  await mkdir(path.join(knowledgeDir, "lessons"), { recursive: true });
  const lessonId = (i.lessonId ?? "l_seed") as LessonId;
  const lesson = sampleLesson(
    "research",
    { generationId: i.generationId, repoId: i.repoId, commitSha: i.commitSha },
    i.sourceId === undefined ? [] : [i.sourceId],
    {
      repoId: i.repoId,
      commitSha: i.commitSha,
      generationId: i.generationId,
      scenarioId: "sc_test",
      moduleIds: ["src"],
    },
  );
  await writeFile(
    path.join(knowledgeDir, "lessons", `${lessonId}.json`),
    `${JSON.stringify({ ...lesson, lessonId }, null, 2)}\n`,
    "utf8",
  );

  const coverage: CoverageReport = i.coverage ?? {
    generationId: i.generationId as never,
    commitSha: i.commitSha,
    complete: true,
    analyzed: [],
    gaps: [],
    counts: { totalFiles: 0, analyzedFiles: 0, excludedFiles: 0 },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
  await writeFile(
    path.join(knowledgeDir, "coverage.json"),
    `${JSON.stringify(coverage, null, 2)}\n`,
    "utf8",
  );

  const at = harness.clock.now().toISOString();
  harness.repos.generations.insertPublished({
    generationId: i.generationId as never,
    cacheKey: `cache:${i.generationId}`,
    repoId: i.repoId as never,
    projectId: (i.projectId ?? null) as never,
    commitSha: i.commitSha,
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: "scope:seed",
    configHash: "config:seed",
    promptTemplateVersion: "prompt",
    preferencesVersion: 1,
    upstreamVersion: "upstream",
    status: "published",
    contentDir: knowledgeDir,
    sealedTreeHash: "sha256:seed",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: at,
    publishedAt: at,
  });
  harness.repos.lessons.insertMany([
    {
      lessonId,
      generationId: i.generationId as never,
      kind: "research",
      title: i.lessonTitle ?? "seed lesson",
      relPath: `lessons/${lessonId}.json`,
      jsonSha256: "sha256:lesson",
      publishedAt: at,
    },
  ]);
  if (i.sourceId !== undefined) {
    harness.repos.sources.insertMany([
      {
        generationId: i.generationId as never,
        sourceId: i.sourceId as never,
        kind: "repo",
        commitSha: i.sourceCommitSha ?? i.commitSha,
        payloadJson: JSON.stringify({
          sourceId: i.sourceId,
          kind: "repo",
          generationId: i.generationId,
          repoId: i.repoId,
          commitSha: i.sourceCommitSha ?? i.commitSha,
          path: i.sourcePath ?? "README.md",
          lines: null,
          contentHash: "sha256:source",
        }),
        contentHash: "sha256:source",
      },
    ]);
  }
  return { knowledgeDir };
}

/**
 * Creates a bare clone of a fixture under `targetDir` and returns its path.
 * The fake GitHub server serves it over Git smart HTTP.
 */
export function createBareRemote(sourcePath: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const repo = path.join(targetDir, "remote.git");
  execFileSync("git", ["clone", "--bare", sourcePath, repo], {
    stdio: "ignore",
  });
  return repo;
}
