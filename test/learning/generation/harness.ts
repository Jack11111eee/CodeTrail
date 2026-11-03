/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * Shared harness for the generation suites.
 *
 * Everything is real except the two seams a test must control: the snapshot
 * service (backed by a plain directory instead of Git) and the upstream
 * generation port (a deterministic writer). The runner, publisher, SQLite
 * database, source registry, lesson-file writer and fault points are the
 * production implementations, so the durability assertions exercise real code.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  computeConfigHash,
  computeDedupeKey,
  computeSealTreeHash,
  jobIdFromDedupeKey,
  LearningError,
  newLessonId,
  repoIdFromIdentity,
} from "../../../src/learning/contracts/index.ts";
import type {
  Clock,
  CoverageReport,
  Database,
  DataPaths,
  EnqueueJobInput,
  ExternalDocService,
  GenerationConfig,
  GenerationId,
  GenerationRecord,
  JobRecord,
  JobRunner,
  JobRunnerDeps,
  JobState,
  Lesson,
  LessonBuilderPort,
  ModelHandle,
  ModelSettings,
  NormalizedScope,
  Publisher,
  Repositories,
  RepoId,
  SealedFile,
  SnapshotRecord,
  SnapshotService,
  SourceRegistry,
  UpstreamGenerationPort,
  UsageMeter,
} from "../../../src/learning/contracts/index.ts";
import {
  LESSON_PIPELINE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../../src/learning/config/defaults.ts";
import {
  ensureDataDir,
  knowledgePath,
  mirrorPath,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import { createSourceRegistry } from "../../../src/learning/evidence/registry.ts";
import { languageOf, normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";
import {
  createScriptedModel,
  SCRIPT_FILE_NAME,
} from "../../../src/learning/testing/scripted-model.ts";
import { createJobRunner } from "../../../src/learning/api/jobs/runner.ts";
import { createPublisher } from "../../../src/learning/api/jobs/publish.ts";
import { createUsageMeter } from "../../../src/learning/api/jobs/usage.ts";

const execFileAsync = promisify(execFile);

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export const DEFAULT_SETTINGS: ModelSettings = {
  provider: "scripted",
  model: "scripted",
  maxOutputTokens: 1024,
  temperature: 0,
  pricing: null,
  quota: { maxCalls: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
};

export const DEFAULT_CONFIG: GenerationConfig = {
  language: "zh",
  model: {
    provider: "scripted",
    model: "scripted",
    maxOutputTokens: 1024,
    temperature: 0,
  },
  pageConcurrency: 1,
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  lessonPipelineVersion: LESSON_PIPELINE_VERSION,
  includeTests: false,
  externalDocs: { enabled: false, maxPerLesson: 0 },
};

export interface HarnessOptions {
  dataDir?: string;
  /** Known ref → sha mappings; full SHAs resolve to themselves. */
  commits?: string[];
  mirrorPath?: string;
  settings?: ModelSettings | null;
  /** Model calls the fake upstream makes for a run. */
  callsFor?: (request: { worktreePath: string }) => number;
  upstream?: UpstreamGenerationPort;
  lessonBuilder?: LessonBuilderPort;
  model?: ModelHandle;
  /** The default builder throws for this commit, exercising failure paths. */
  failForSha?: string;
  /** Seed the fake source tree and repo row. Default true. */
  seedRepo?: boolean;
}

export interface Harness {
  dataDir: string;
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: Clock;
  usage: UsageMeter;
  publisher: Publisher;
  runner: JobRunner;
  registry: SourceRegistry;
  repoId: RepoId;
  mirrorPath: string;
  scope: NormalizedScope;
  config: GenerationConfig;
  calls: { count: number };
  shas: string[];
  sourceDir(sha: string): string;
  close(): void;
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function relativeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSyncSafe(directory)) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

function readdirSyncSafe(directory: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Sealed generations are read-only; the temp-dir cleanup needs write bits. */
function makeWritableSync(root: string): void {
  for (const entry of readdirSyncSafe(root)) {
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
    // The directory may already be gone.
  }
}

export async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
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

export async function readSealManifest(knowledgeDir: string): Promise<{
  schemaVersion: number;
  generationId: string;
  treeHash: string;
  files: SealedFile[];
}> {
  return JSON.parse(
    await readFile(path.join(knowledgeDir, "seal.json"), "utf8"),
  ) as {
    schemaVersion: number;
    generationId: string;
    treeHash: string;
    files: SealedFile[];
  };
}

export function sampleLesson(
  kind: "research" | "change" | "comparison",
  generation: { generationId: GenerationId; repoId: RepoId; commitSha: string },
  sourceIds: readonly string[],
  context: Record<string, unknown>,
): Lesson {
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
    diagram: { kind: "component", mermaid: "flowchart LR", nodes: [], edges: [] },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
  } as unknown as Lesson;
}

function coverageFor(
  snapshot: SnapshotRecord,
  generationId: GenerationId,
  files: { path: string; bytes: number }[],
): CoverageReport {
  return {
    generationId,
    commitSha: snapshot.commitSha,
    complete: true,
    analyzed: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      language: languageOf(file.path),
    })),
    gaps: [],
    counts: {
      totalFiles: files.length,
      analyzedFiles: files.length,
      excludedFiles: 0,
    },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

async function filesWithSizes(
  root: string,
): Promise<{ path: string; bytes: number }[]> {
  const files = await listRelativeFiles(root);
  const sizes: { path: string; bytes: number }[] = [];
  for (const file of files) {
    sizes.push({ path: file, bytes: (await stat(path.join(root, file))).size });
  }
  return sizes;
}

export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const dataDir = options.dataDir ?? process.env.CODETRAIL_DATA_DIR;
  if (dataDir === undefined || dataDir === "") {
    throw new Error("CODETRAIL_DATA_DIR is required");
  }
  const paths = resolveDataPaths({ ...process.env, CODETRAIL_DATA_DIR: dataDir });
  await ensureDataDir(paths);

  const clock = createClock("2026-01-01T00:00:00.000Z");
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  const repos = createRepositories(db);

  const repoId = repoIdFromIdentity(`local:${dataDir}`);
  const mirror = options.mirrorPath ?? mirrorPath(paths, repoId);
  const shas = options.commits ?? [SHA_A, SHA_B, SHA_C];
  const scope = normalizeScope();
  const config = DEFAULT_CONFIG;

  if (options.seedRepo !== false) {
    repos.repos.upsert({
      repoId,
      identity: `local:${dataDir}`,
      kind: "local",
      mirrorPath: mirror,
      remoteUrl: null,
      createdAt: clock.now().toISOString(),
    });
  }

  const settings = options.settings === undefined ? DEFAULT_SETTINGS : options.settings;
  if (settings !== null) {
    repos.settings.putModel(settings);
  }

  const sourceRoot = path.join(paths.root, "test-sources");
  const sourceDir = (sha: string): string => path.join(sourceRoot, sha);
  for (const sha of shas) {
    const directory = sourceDir(sha);
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(
      path.join(directory, "src", "index.ts"),
      `export const commit = "${sha}";\n`,
      "utf8",
    );
  }

  const snapshotService: SnapshotService = {
    async resolve(_repoId, ref): Promise<string> {
      const trimmed = ref.trim();
      if (/^[0-9a-f]{40}$/u.test(trimmed)) return trimmed;
      return shas[0];
    },
    async ensure(repoIdArg, sha): Promise<SnapshotRecord> {
      return {
        repoId: repoIdArg,
        commitSha: sha,
        treeHash: `tree:${sha}`,
        worktreePath: sourceDir(sha),
        resolvedAt: clock.now().toISOString(),
      };
    },
    async readFile(snap, relPath): Promise<string> {
      return readFile(path.join(snap.worktreePath, relPath), "utf8");
    },
    async listFiles(snap): Promise<{ path: string; bytes: number }[]> {
      return filesWithSizes(snap.worktreePath);
    },
    async coverage(snap, _scope, generationId): Promise<CoverageReport> {
      return coverageFor(snap, generationId, await filesWithSizes(snap.worktreePath));
    },
  };

  const calls = { count: 0 };
  const callsFor =
    options.callsFor ??
    ((request: { worktreePath: string }) =>
      existsSync(path.join(request.worktreePath, "openwiki", "quickstart.md"))
        ? 1
        : 3);

  const upstream: UpstreamGenerationPort =
    options.upstream ?? {
      async run(request) {
        const total = callsFor(request);
        for (let index = 0; index < total; index += 1) {
          await (request.model as unknown as {
            invoke: (input: string) => Promise<unknown>;
          }).invoke(`call ${index}`);
        }
        const wiki = path.join(request.worktreePath, "openwiki");
        await mkdir(path.join(wiki, ".claims"), { recursive: true });
        await writeFile(
          path.join(wiki, "quickstart.md"),
          `# Quickstart\n\ncommit ${path.basename(request.worktreePath)}\n`,
          "utf8",
        );
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
        // Recovery state must never become content.
        await writeFile(
          path.join(wiki, ".run.json"),
          JSON.stringify({ status: "running" }),
          "utf8",
        );
        return { skipped: false, sourceChanged: true };
      },
      sourceFingerprint: async () => "fingerprint",
      treeHashOfWorktree: async () => "tree",
      changedPaths: async () => [],
      lastUpdate: async () => null,
      pageManifest: async () => null,
    };

  const lessons: LessonBuilderPort =
    options.lessonBuilder ?? {
      async buildResearchLessons(input) {
        if (options.failForSha === input.generation.commitSha) {
          throw new LearningError("internal_error", "lesson build failed");
        }
        const ref = await input.registry.registerRepo({
          generationId: input.generation.generationId,
          repoId: input.generation.repoId,
          commitSha: input.generation.commitSha,
          path: "src/index.ts",
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
        const ref = await input.registry.registerRepo({
          generationId: input.generation.generationId,
          repoId: input.generation.repoId,
          commitSha: input.generation.commitSha,
          path: "src/index.ts",
          lines: null,
          snapshot: input.headSnapshot,
          scope: input.scope,
        });
        const lesson = sampleLesson(
          "change",
          input.generation,
          [ref.sourceId],
          {
            repoId: input.generation.repoId,
            commitSha: input.generation.commitSha,
            generationId: input.generation.generationId,
            scenarioId: "sc_test",
            moduleIds: ["src"],
          },
        ) as unknown as Record<string, unknown>;
        lesson.eventId = input.event.eventId;
        lesson.behaviorChange = { before: "before", after: "after" };
        lesson.affectedModules = [];
        lesson.keyTechnologies = [];
        lesson.alternatives = [];
        lesson.unverifiedEffects = [];
        lesson.omittedReasons = {};
        return {
          lessons: [lesson as unknown as Lesson],
          failures: [],
          blankTeaching: false,
        };
      },
      async buildComparisonLesson(input) {
        const head = await input.registry.registerRepo({
          generationId: input.generation.generationId,
          repoId: input.head.repoId,
          commitSha: input.head.commitSha,
          path: "src/index.ts",
          lines: null,
          snapshot: input.headSnapshot,
          scope: input.scope,
        });
        const base = await input.registry.registerRepo({
          generationId: input.generation.generationId,
          repoId: input.base.repoId,
          commitSha: input.base.commitSha,
          path: "src/index.ts",
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
          lessons: [lesson as unknown as Lesson],
          failures: [],
          blankTeaching: false,
        };
      },
    };

  const external: ExternalDocService = {
    fetchExact: async () => ({
      ok: false,
      status: "source_missing",
      reason: "not_found",
    }),
    cached: async () => null,
  };

  const scriptDir = path.join(paths.root, "test-scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(
    path.join(scriptDir, SCRIPT_FILE_NAME),
    JSON.stringify({
      scripts: Array.from({ length: 24 }, (_, index) => ({
        workerKind: "planner",
        occurrence: index + 1,
        steps: [{ content: "ok" }],
      })),
    }),
    "utf8",
  );
  const chatModel = createScriptedModel({
    dir: scriptDir,
    role: "repo_job",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    onCall: () => {
      calls.count += 1;
    },
  });
  const model: ModelHandle =
    options.model ?? {
      modelId: "scripted",
      settings: settings ?? DEFAULT_SETTINGS,
      chat: () => chatModel,
      estimate: () => ({ calls: 1, tokens: 100 }),
    };

  const usage = createUsageMeter({ db, repos, clock });
  const publisher = createPublisher({ paths, db, repos, clock });
  const registry = createSourceRegistry({
    clock,
    sources: repos.sources,
    generations: repos.generations,
  });

  const deps: JobRunnerDeps = {
    db,
    repos,
    paths,
    clock,
    snapshotService,
    publisher,
    upstream,
    lessons,
    model,
    usage,
    registry,
    external,
  };
  const runner = createJobRunner(deps);

  return {
    dataDir,
    paths,
    db,
    repos,
    clock,
    usage,
    publisher,
    runner,
    registry,
    repoId,
    mirrorPath: mirror,
    scope,
    config,
    calls,
    shas,
    sourceDir,
    close: () => {
      makeWritableSync(paths.root);
      db.close();
    },
  };
}

// ── enqueue inputs ──────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Enqueues and waits for the writer loop to go idle. */
export async function runToCompletion(
  harness: Harness,
  input: EnqueueJobInput,
): Promise<import("../../../src/learning/contracts/index.ts").JobRecord> {
  const job = await harness.runner.enqueue(input);
  await harness.runner.drain();
  return (await harness.runner.get(job.jobId))!;
}

/** Polls until the job reaches `state` (or the timeout expires). */
export async function waitForState(
  harness: Harness,
  jobId: import("../../../src/learning/contracts/index.ts").JobId,
  state: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await harness.runner.get(jobId);
    if (job?.state === state) return;
    await sleep(5);
  }
  throw new Error(`job ${jobId} never reached ${state}`);
}

/** Inserts a job row directly, without scheduling it. */
export function insertJob(
  harness: Harness,
  input: EnqueueJobInput,
  state: JobState,
  options: { attempt?: number } = {},
): JobRecord {
  const dedupeKey = computeDedupeKey(input);
  const jobId = jobIdFromDedupeKey(dedupeKey);
  const at = harness.clock.now().toISOString();
  const attempt = options.attempt ?? (state === "running" ? 1 : 0);
  harness.repos.jobs.insert({
    jobId,
    dedupeKey,
    kind: input.kind,
    repoId: input.repoId,
    projectId: input.projectId,
    streamId: input.streamId,
    state,
    payload: input.payload,
    attempt,
    errorCode: null,
    errorDetail: null,
    progress: null,
    outputGenerationId: null,
    createdAt: at,
    startedAt: state === "running" ? at : null,
    finishedAt: state === "running" ? null : at,
  });
  if (state === "running") {
    harness.repos.attempts.open(jobId, attempt, at);
  }
  return harness.repos.jobs.byId(jobId) as JobRecord;
}

export function generationInput(
  harness: Harness,
  options: {
    sha: string;
    mode?: "init" | "update";
    ref?: string;
    baselineFromGenerationId?: GenerationId | null;
    config?: GenerationConfig;
    scope?: NormalizedScope;
    streamId?: string | null;
  },
): EnqueueJobInput {
  const config = options.config ?? harness.config;
  const scope = options.scope ?? harness.scope;
  return {
    kind: options.mode === "update" ? "generation_update" : "generation_initial",
    repoId: harness.repoId,
    projectId: null,
    streamId: options.streamId ?? null,
    comparisonBaseSha: null,
    headSha: options.sha,
    baseContextSha: null,
    scopeHash: scope.hash,
    analysisConfigHash: computeConfigHash(config),
    payload: {
      kind: "generation",
      mode: options.mode ?? "init",
      ref: options.ref ?? options.sha,
      commitSha: options.sha,
      baseContextSha: null,
      scope,
      config,
      baselineFromGenerationId: options.baselineFromGenerationId ?? null,
    },
  };
}

export function comparisonInput(
  harness: Harness,
  options: { baseSha: string; headSha: string },
): EnqueueJobInput {
  const scope = harness.scope;
  const config = harness.config;
  return {
    kind: "comparison",
    repoId: harness.repoId,
    projectId: null,
    streamId: `cmp:${options.baseSha.slice(0, 12)}..${options.headSha.slice(0, 12)}`,
    comparisonBaseSha: options.baseSha,
    headSha: options.headSha,
    baseContextSha: options.baseSha,
    scopeHash: scope.hash,
    analysisConfigHash: computeConfigHash(config),
    payload: {
      kind: "comparison",
      baseSha: options.baseSha,
      headSha: options.headSha,
      scope,
      config,
    },
  };
}

// ── published-generation seeding ────────────────────────────────────────────

export interface SeededGeneration {
  generationId: GenerationId;
  knowledgeDir: string;
  treeHash: string;
}

/**
 * Writes a complete, sealed knowledge directory and its published row. Used by
 * the baseline and failure suites; it is byte-for-byte what `Publisher` writes.
 */
export async function seedPublishedGeneration(
  harness: Harness,
  options: {
    generationId: GenerationId;
    commitSha: string;
    upstreamVersion?: string;
    promptTemplateVersion?: string;
    language?: string;
    withRunJson?: boolean;
    pages?: Record<string, string>;
  },
): Promise<SeededGeneration> {
  const knowledgeDir = knowledgePath(harness.paths, options.generationId);
  await mkdir(path.join(knowledgeDir, "openwiki", ".claims"), {
    recursive: true,
  });
  const pages = options.pages ?? { quickstart: "# Baseline\n" };
  for (const [page, body] of Object.entries(pages)) {
    await writeFile(
      path.join(knowledgeDir, "openwiki", `${page}.md`),
      body,
      "utf8",
    );
    await writeFile(
      path.join(knowledgeDir, "openwiki", ".claims", `${page}.json`),
      JSON.stringify({ schemaVersion: 1, claims: [] }),
      "utf8",
    );
  }
  await writeFile(
    path.join(knowledgeDir, "openwiki", ".page-manifest.json"),
    JSON.stringify({ schemaVersion: 1, pages: {} }),
    "utf8",
  );
  await writeFile(
    path.join(knowledgeDir, "generation.json"),
    JSON.stringify({
      commitSha: options.commitSha,
      repoId: harness.repoId,
      upstreamVersion: options.upstreamVersion ?? UPSTREAM_VERSION,
      promptTemplateVersion:
        options.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSION,
      language: options.language ?? "zh",
    }),
    "utf8",
  );
  if (options.withRunJson === true) {
    await writeFile(
      path.join(knowledgeDir, "openwiki", ".run.json"),
      JSON.stringify({ status: "complete" }),
      "utf8",
    );
  }

  const files: SealedFile[] = [];
  for (const relative of await listRelativeFiles(knowledgeDir)) {
    if (relative === "seal.json") continue;
    const content = await readFile(path.join(knowledgeDir, relative));
    files.push({
      path: relative,
      sha256: sha256Hex(content),
      bytes: content.byteLength,
    });
  }
  const treeHash = computeSealTreeHash(files);
  await writeFile(
    path.join(knowledgeDir, "seal.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generationId: options.generationId,
        treeHash,
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const now = harness.clock.now().toISOString();
  const record: GenerationRecord = {
    generationId: options.generationId,
    cacheKey: `cache:${options.generationId}`,
    repoId: harness.repoId,
    projectId: null,
    commitSha: options.commitSha,
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: harness.scope.hash,
    configHash: computeConfigHash(harness.config),
    promptTemplateVersion:
      options.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSION,
    preferencesVersion: 0,
    upstreamVersion: options.upstreamVersion ?? UPSTREAM_VERSION,
    status: "published",
    contentDir: knowledgeDir,
    sealedTreeHash: treeHash,
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: now,
    publishedAt: now,
  };
  harness.repos.generations.insertPublished(record);
  return { generationId: options.generationId, knowledgeDir, treeHash };
}

/** Creates a real repository with one commit per message; returns its SHAs. */
export async function createGitRepository(
  harness: Harness,
  messages: string[],
): Promise<{ root: string; shas: string[] }> {
  const root = mkdtempSync(path.join(harness.paths.root, "test-repo-"));
  const shas = await createGitRepositoryAt(root, messages);
  return { root, shas };
}

export async function createGitRepositoryAt(
  root: string,
  messages: string[],
): Promise<string[]> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Generation Test"], {
    cwd: root,
  });
  const shas: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    await writeFile(
      path.join(root, "src.ts"),
      `export const value = ${index};\n`,
      "utf8",
    );
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", messages[index]], {
      cwd: root,
    });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    shas.push(stdout.trim());
  }
  return shas;
}

export function isLearningError(error: unknown, code: string): boolean {
  return error instanceof LearningError && error.code === code;
}
