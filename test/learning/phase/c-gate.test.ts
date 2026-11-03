/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * Phase C gate (AC-GATE-C, PRD §10/§15.4, architecture §12, §17.2–§17.4, §18,
 * §21 invariant 4).
 *
 * Phase C is what an operator can *observe* about change follow-up: every
 * observable change on the default branch or a pull request becomes exactly one
 * durable event, a repeated delivery adds no second row or job, a failed
 * analysis keeps its event while its stream parks, the two streams advance
 * independently, and a PR preview generation is never confused with the
 * default-branch generation.
 *
 * The gate drives the production pipeline end to end:
 *   - `watch-remote.git` (via `makeBareRemote`) is the real history the mirror
 *     is cloned from;
 *   - a real working clone is mutated to script the sequence, and
 *     `fetchMirror` moves every commit into the production mirror;
 *   - `createGithubClient` reads the default branch and its commits from the
 *     fake GitHub server (architecture §17.2);
 *   - `runWatchTick` performs discovery, `commitDiscovery` writes the events +
 *     jobs + cursor transaction, and the production job pipeline publishes the
 *     change lessons;
 *   - `GET /api/projects/:id/changes` is walked to prove every event is
 *     reachable.
 *
 * Assertions are about counts and cursors, never a hardcoded event list: the
 * gate maintains its own tally of the observable changes it scripted and
 * compares it with what discovery persisted. Event keys and dedupe keys are
 * recomputed independently from the stored columns.
 *
 * The CLI-contract block is skipped when this file runs *inside* `phase:check`
 * (`CODETRAIL_PHASE_CHECK=1`), otherwise `--through=D` would re-enter it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { createSessionStore } from "../../../src/learning/api/auth.ts";
import {
  createModelGate,
  executeJob,
} from "../../../src/learning/api/jobs/pipeline.ts";
import { createPublisher } from "../../../src/learning/api/jobs/publish.ts";
import { createUsageMeter } from "../../../src/learning/api/jobs/usage.ts";
import {
  registerRouteModule,
} from "../../../src/learning/api/router.ts";
import { changesModule } from "../../../src/learning/api/routes/changes.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import {
  LESSON_PIPELINE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../../src/learning/config/defaults.ts";
import {
  computeCacheKey,
  computeConfigHash,
  computeDedupeKey,
  computeEventKey,
  LearningError,
  repoIdFromIdentity,
} from "../../../src/learning/contracts/index.ts";
import type {
  AppDeps,
  BuildChangeLessonInput,
  BuildLessonsResult,
  ChangeListView,
  ChangeRecord,
  Clock,
  Database,
  GenerationConfig,
  GithubClient,
  JobRecord,
  JobRunner,
  JobRunnerDeps,
  Lesson,
  LessonBuilderPort,
  ModelHandle,
  ProjectId,
  PullRequestMeta,
  Repositories,
  RepoRecord,
  RunningServer,
  WatchDeps,
  WatchTickResult,
} from "../../../src/learning/contracts/index.ts";
import { createSourceRegistry } from "../../../src/learning/evidence/index.ts";
import { normalizeScope } from "../../../src/learning/projects/index.ts";
import {
  cloneMirror,
  createSnapshotService,
  fetchMirror,
} from "../../../src/learning/projects/index.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";
import { makeBareRemote } from "../../../src/learning/testing/faults.ts";
import {
  DEFAULT_BRANCH_STREAM,
  PULL_REQUEST_DISCOVERY_STREAM,
  createDiscoveryService,
} from "../../../src/learning/updates/discovery.ts";
import { createGithubClient } from "../../../src/learning/updates/github-client.ts";
import { runWatchTick } from "../../../src/learning/updates/watch.ts";
import {
  createStubGithub,
  makePull,
  type GitRepo,
  type PullFixture,
} from "../updates/harness.ts";
import { sampleLesson } from "../generation/harness.ts";
import { fixturesDir, requireFixtures } from "../helpers/git-fixture.ts";
import { startFakeGithub } from "../helpers/fake-github.ts";
import type { FakeGithub } from "../helpers/fake-github.ts";
import { startHarness } from "../helpers/http-client.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PHASE_CHECK = path.join(REPO_ROOT, "scripts", "phase-check.mjs");
const INSIDE_PHASE_CHECK = process.env.CODETRAIL_PHASE_CHECK === "1";

const FIXTURE = "watch-remote";
const OWNER_REPO = "acme/widgets";
const IDENTITY = `github:${OWNER_REPO}`;
const PROJECT_ID = "p_phase_c" as ProjectId;
const PROJECT_NAME = "widgets";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const TICK_MS = 60_000;
const PR_UPDATED_OFFSET_MS = 30_000;
const PREVIEW_PATH = "src/pr-preview.ts";

// ── the scripted working remote (real Git) ───────────────────────────────────

interface RemoteRepo {
  path: string;
  git(args: string[]): string;
  write(relPath: string, content: string): void;
  commit(message: string): string;
  merge(branch: string, message: string): string;
  createBranch(name: string): void;
  checkout(name: string): void;
  renameBranch(from: string, to: string): void;
  forceBranch(name: string, sha: string): void;
  orphan(name: string): void;
  head(rev?: string): string;
  parents(sha: string): string[];
  commitList(rev: string): string[];
  cleanup(): void;
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function scriptEnv(tick: number): NodeJS.ProcessEnv {
  const date = new Date(Date.UTC(2024, 4, 1, 0, 0, 0) + tick * 60_000)
    .toISOString();
  return {
    ...process.env,
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Codetrail Phase C",
    GIT_AUTHOR_EMAIL: "c-gate@codetrail.invalid",
    GIT_COMMITTER_NAME: "Codetrail Phase C",
    GIT_COMMITTER_EMAIL: "c-gate@codetrail.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * A mutable clone of the `watch-remote.git` fixture. Discovery reads the
 * production mirror, so every scripted change here is pushed into it with
 * `fetchMirror`; the clone itself is only the script's authoring surface.
 */
function createRemote(fixtureUrl: string): RemoteRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-c-gate-remote-"));
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", fixtureUrl, dir], {
    env: scriptEnv(0),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let tick = 0;
  const git = (args: string[]): string => {
    tick += 1;
    return execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "core.autocrlf=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      {
        env: scriptEnv(tick),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  };

  return {
    path: dir,
    git,
    write(relPath, content) {
      const absolute = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, "utf8");
    },
    commit(message) {
      git(["add", "-A"]);
      git(["commit", "--allow-empty", "-m", message]);
      return git(["rev-parse", "HEAD"]);
    },
    merge(branch, message) {
      git(["merge", "--no-ff", branch, "-m", message]);
      return git(["rev-parse", "HEAD"]);
    },
    createBranch(name) {
      git(["checkout", "-q", "-b", name]);
    },
    checkout(name) {
      git(["checkout", "-q", name]);
    },
    renameBranch(from, to) {
      git(["branch", "-m", from, to]);
    },
    forceBranch(name, sha) {
      git(["branch", "-f", name, sha]);
    },
    orphan(name) {
      git(["checkout", "-q", "--orphan", name]);
      git(["rm", "-rf", "."]);
    },
    head(rev = "HEAD") {
      return git(["rev-parse", rev]);
    },
    parents(sha) {
      const fields = git(["rev-list", "--parents", "-n", "1", sha]).split(
        /\s+/u,
      );
      return fields.slice(1).filter((value) => value !== "");
    },
    commitList(rev) {
      return git(["rev-list", rev])
        .split("\n")
        .filter((value) => value !== "");
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── the gate harness ─────────────────────────────────────────────────────────

interface BuildCapture {
  commitSha: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  diffPaths: string[];
  headHasPreview: boolean;
  previewText: string | null;
}

interface GateOptions {
  /** Reuse the same working clone (a restart). */
  remote?: RemoteRepo;
  clock?: Clock;
}

interface Gate {
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: Clock;
  remote: RemoteRepo;
  fake: FakeGithub;
  projectId: ProjectId;
  repo: RepoRecord;
  deps: WatchDeps;
  builds: BuildCapture[];
  events(): ChangeRecord[];
  jobs(): JobRecord[];
  changeJobs(): JobRecord[];
  cursor(
    streamId: string,
    kind?: "discovery" | "published",
  ): ReturnType<Repositories["cursors"]["get"]>;
  setPulls(pulls: PullRequestMeta[]): void;
  /** Makes the change analysis fail for this commit; `null` clears it. */
  setFailForSha(sha: string | null): void;
  tick(): Promise<WatchTickResult>;
  /** Pushes every local head into the production mirror and updates the fake. */
  sync(options?: { renameTo?: string; force?: boolean }): Promise<void>;
  runPending(options?: {
    streamKind?: "default_branch" | "pull_request";
  }): Promise<void>;
  /** Opens the real changes route over loopback for the same store. */
  startChangesServer(): Promise<RunningServer>;
  close(): Promise<void>;
  cleanup(): void;
}

const gates: Gate[] = [];

function noopJobRunner(): JobRunner {
  const fail = async (): Promise<never> => {
    throw new Error("the watch tick never schedules through the runner");
  };
  return {
    enqueue: fail,
    get: async () => null,
    cancel: fail,
    retry: fail,
    recoverInterrupted: async () => 0,
    drain: async () => undefined,
    subscribe: () => () => undefined,
  };
}

/** The pipeline's `defaultConfig` (§7.5), mirrored for independent recompute. */
function gateConfig(): GenerationConfig {
  return {
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
  };
}

async function createGate(options: GateOptions = {}): Promise<Gate> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);
  const clock = options.clock ?? createClock(FIXED_NOW);
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  const repos = createRepositories(db);

  const repoId = repoIdFromIdentity(IDENTITY);
  let repo = repos.repos.byId(repoId);
  if (repo === null) {
    const mirror = await cloneMirror(paths, IDENTITY, {
      remoteUrl: makeBareRemote(fixturesDir(), FIXTURE),
    });
    repo = repos.repos.upsert({
      repoId,
      identity: IDENTITY,
      kind: "github",
      mirrorPath: mirror.path,
      remoteUrl: `https://github.com/${OWNER_REPO}.git`,
      createdAt: clock.now().toISOString(),
    });
  }

  const project = repos.projects.byId(PROJECT_ID);
  if (project === null) {
    repos.projects.insert({
      projectId: PROJECT_ID,
      repoId,
      kind: "github",
      displayName: PROJECT_NAME,
      remoteUrl: `https://github.com/${OWNER_REPO}.git`,
      defaultBranch: "main",
      scope: normalizeScope(),
      watchEnabled: true,
      createdAt: clock.now().toISOString(),
      deletedAt: null,
    });
  }

  const ownsRemote = options.remote === undefined;
  const remote =
    options.remote ?? createRemote(makeBareRemote(fixturesDir(), FIXTURE));

  // Only the default-branch half is served by the HTTP fake: its PR generator
  // cannot mutate, so PR metadata comes from the deterministic in-process
  // client backed by the same real Git repository (architecture §17.2).
  const fake = await startFakeGithub({
    ownerRepo: OWNER_REPO,
    pages: 1,
    perPage: 1,
  });
  const httpClient = createGithubClient({
    baseUrl: fake.baseUrl,
    credential: null,
    clock,
  });
  const prClient = createStubGithub({
    repo: {
      parents: (sha: string) => remote.parents(sha),
      git: (args: string[]) => remote.git(args),
      commitList: (rev: string) => remote.commitList(rev),
    } as unknown as GitRepo,
    branch: "main",
    pulls: [],
  });
  const github: GithubClient = {
    defaultBranch: (ownerRepo) => httpClient.defaultBranch(ownerRepo),
    commitsSince: (...args) => httpClient.commitsSince(...args),
    pullRequests: (...args) => prClient.pullRequests(...args),
    pullRequest: (...args) => prClient.pullRequest(...args),
    rateLimit: () => httpClient.rateLimit(),
  };

  // Prime the fake with the fixture's real head so observation starts from the
  // commit the mirror actually contains.
  fake.pushCommit(remote.head("main"));

  const snapshotService = createSnapshotService({ paths, repos, clock });
  const publisher = createPublisher({ paths, db, repos, clock });
  const registry = createSourceRegistry({
    clock,
    sources: repos.sources,
    generations: repos.generations,
  });
  const usage = createUsageMeter({ db, repos, clock });

  const model: ModelHandle = {
    modelId: "scripted",
    settings: {
      provider: "scripted",
      model: "scripted",
      maxOutputTokens: 1024,
      temperature: 0,
      pricing: null,
      quota: {
        maxCalls: 1000,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
      },
    },
    // The scripted lesson builder below never calls the model.
    chat: () => ({}) as never,
    estimate: () => ({ calls: 0, tokens: 0 }),
  };

  const builds: BuildCapture[] = [];
  let failForSha: string | null = null;
  const lessons: LessonBuilderPort = {
    buildResearchLessons: async (): Promise<BuildLessonsResult> => ({
      lessons: [],
      failures: [],
      blankTeaching: false,
    }),
    buildComparisonLesson: async (): Promise<BuildLessonsResult> => ({
      lessons: [],
      failures: [],
      blankTeaching: false,
    }),
    buildChangeLesson: async (
      input: BuildChangeLessonInput,
    ): Promise<BuildLessonsResult> => {
      if (failForSha !== null && failForSha === input.generation.commitSha) {
        throw new LearningError("internal_error", "injected change analysis");
      }
      const files = await input.headSnapshot.list(input.scope);
      const sourcePath = files[0]?.path ?? "README.md";
      const ref = await input.registry.registerRepo({
        generationId: input.generation.generationId,
        repoId: input.generation.repoId,
        commitSha: input.generation.commitSha,
        path: sourcePath,
        lines: null,
        snapshot: input.headSnapshot,
        scope: input.scope,
      });
      const headHasPreview = await input.headSnapshot.exists(PREVIEW_PATH);
      builds.push({
        commitSha: input.generation.commitSha,
        baseSha: input.event.baseSha ?? "",
        headSha: input.event.headSha ?? "",
        mergeBaseSha: input.event.mergeBaseSha ?? "",
        diffPaths: input.diff.entries.map((entry) => entry.path),
        headHasPreview,
        previewText: headHasPreview
          ? await input.headSnapshot.read(PREVIEW_PATH)
          : null,
      });
      const lesson = sampleLesson("change", input.generation, [ref.sourceId], {
        repoId: input.generation.repoId,
        commitSha: input.generation.commitSha,
        generationId: input.generation.generationId,
        scenarioId: "sc_change",
        moduleIds: [],
      }) as unknown as Record<string, unknown>;
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
  };

  const external = {
    fetchExact: async () => ({
      ok: false as const,
      status: "source_missing" as const,
      reason: "not_found" as const,
    }),
    cached: async () => null,
  };

  const jobDeps: JobRunnerDeps = {
    db,
    repos,
    paths,
    clock,
    snapshotService,
    publisher,
    upstream: {} as never,
    lessons,
    model,
    usage,
    registry,
    external,
  };
  const modelGate = createModelGate();

  const discovery = createDiscoveryService({ db, repos, clock, github, paths });
  const deps: WatchDeps = {
    db,
    repos,
    clock,
    github,
    discovery,
    jobRunner: noopJobRunner(),
    intervalMs: 300_000,
  };

  const ALL_JOB_STATES = [
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ] as const;

  let closed = false;
  const gate: Gate = {
    paths,
    db,
    repos,
    clock,
    remote,
    fake,
    projectId: PROJECT_ID,
    repo,
    deps,
    builds,
    events() {
      return repos.changes.page(PROJECT_ID, null, 1_000).items;
    },
    jobs() {
      return repos.jobs.listByProject(PROJECT_ID, [...ALL_JOB_STATES]);
    },
    changeJobs() {
      return gate
        .jobs()
        .filter((job) => job.kind === "change_analysis");
    },
    cursor(streamId, kind = "discovery") {
      return repos.cursors.get(repoId, streamId, kind);
    },
    setPulls(pulls) {
      prClient.setPulls(pulls);
    },
    setFailForSha(sha) {
      failForSha = sha;
    },
    tick() {
      return runWatchTick(deps, PROJECT_ID);
    },
    async sync(syncOptions = {}) {
      await fetchMirror(paths, repoId, {
        remoteUrl: pathToFileURL(remote.path).href,
        refspecs: ["+refs/heads/*:refs/heads/*"],
      });
      const branch = syncOptions.renameTo ?? "main";
      if (syncOptions.renameTo !== undefined) {
        fake.renameDefaultBranch(syncOptions.renameTo);
      }
      const head = remote.head(branch);
      if (syncOptions.force === true) {
        fake.forcePush(branch, head);
      } else {
        fake.pushCommit(head);
      }
    },
    async runPending(runOptions = {}) {
      for (;;) {
        const queued = repos.jobs
          .listByProject(PROJECT_ID, ["queued"])
          .filter(
            (job) =>
              runOptions.streamKind === undefined ||
              (job.payload.kind === "change" &&
                job.payload.streamKind === runOptions.streamKind),
          );
        if (queued.length === 0) return;
        const job = queued[0];
        const at = clock.now().toISOString();
        const started = repos.jobs.transition(
          job.jobId,
          ["queued"],
          "running",
          {
            startedAt: at,
            attempt: 1,
            errorCode: null,
            errorDetail: null,
            finishedAt: null,
          },
        );
        if (!started) continue;
        repos.attempts.open(job.jobId, 1, at);
        const current = repos.jobs.byId(job.jobId);
        if (current === null) continue;
        try {
          const result = await executeJob({
            deps: jobDeps,
            job: current,
            signal: new AbortController().signal,
            gate: modelGate,
          });
          const latest = repos.jobs.byId(job.jobId);
          if (latest !== null && latest.state === "running") {
            repos.jobs.transition(job.jobId, ["running"], "completed", {
              outputGenerationId: result.generationId,
              finishedAt: clock.now().toISOString(),
              errorCode: null,
              errorDetail: null,
            });
          }
        } catch (error) {
          const latest = repos.jobs.byId(job.jobId);
          if (latest !== null && latest.state === "running") {
            repos.jobs.transition(job.jobId, ["running"], "failed", {
              finishedAt: clock.now().toISOString(),
              errorCode: "internal_error",
              errorDetail:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    },
    async startChangesServer() {
      registerRouteModule(changesModule);
      const session = createSessionStore(paths);
      const appDeps = {
        paths,
        clock,
        db,
        repos,
        session,
        watch: {
          start(): void {},
          stop(): void {},
          runTick: async () => [],
          lastPollAt: () => null,
        },
      } as unknown as AppDeps;
      return createLearningServer({ paths, port: 0, clock, deps: appDeps });
    },
    async close() {
      if (closed) return;
      closed = true;
      await fake.close().catch(() => undefined);
      try {
        db.close();
      } catch {
        // already closed
      }
    },
    cleanup() {
      if (!ownsRemote) return;
      remote.cleanup();
    },
  };

  gates.push(gate);
  return gate;
}

afterEach(async () => {
  for (const gate of gates.splice(0)) {
    await gate.close();
    gate.cleanup();
    // Published knowledge trees are sealed read-only; the per-test data dir
    // remover needs write bits before it can unlink them.
    makeWritableSync(gate.paths.root);
  }
});

/** Restores write bits so a sealed data directory can be deleted. */
function makeWritableSync(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeWritableSync(child);
      try {
        fs.chmodSync(child, 0o755);
      } catch {
        // best effort
      }
    } else if (entry.isFile()) {
      try {
        fs.chmodSync(child, 0o644);
      } catch {
        // best effort
      }
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // best effort
  }
}

beforeAll(() => {
  if (!fs.existsSync(path.join(fixturesDir(), "manifest.json"))) {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  }
  requireFixtures();
}, 180_000);

// ── shared assertions ────────────────────────────────────────────────────────

function expectNoDuplicateEvents(gate: Gate): void {
  const events = gate.events();
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  expect(new Set(events.map((event) => event.eventKey)).size).toBe(
    events.length,
  );

  // Every stored key is recomputable from the stored columns (§3.6, §12.2).
  for (const event of events) {
    expect(
      computeEventKey({
        repoId: event.repoId,
        streamId: event.streamId,
        kind: event.kind,
        baseSha: event.baseSha,
        headSha: event.headSha,
        mergeBaseSha: event.mergeBaseSha,
        baseContextSha: event.baseContextSha,
      }),
      `${event.kind} ${event.eventId}`,
    ).toBe(event.eventKey);
  }

  const jobs = gate.changeJobs();
  expect(new Set(jobs.map((job) => job.jobId)).size).toBe(jobs.length);
  expect(new Set(jobs.map((job) => job.dedupeKey)).size).toBe(jobs.length);

  // jobs === distinct events that enqueued one; no event shares a job.
  const withJobs = events.filter((event) => event.jobId !== null);
  expect(jobs).toHaveLength(withJobs.length);
  const jobIds = new Set(jobs.map((job) => job.jobId));
  for (const event of withJobs) expect(jobIds.has(event.jobId!)).toBe(true);

  // Dedupe keys are independent of the stored row: recompute from the event
  // plus the project scope/config the discovery transaction used.
  const project = gate.repos.projects.byId(gate.projectId)!;
  const configHash = computeConfigHash(gateConfig());
  for (const event of withJobs) {
    const job = gate.repos.jobs.byId(event.jobId!)!;
    expect(
      computeDedupeKey({
        repoId: event.repoId,
        streamId: event.streamId,
        comparisonBaseSha: null,
        headSha: event.headSha!,
        baseContextSha: event.baseContextSha,
        scopeHash: project.scope.hash,
        analysisConfigHash: configHash,
      }),
      `${event.kind} ${event.eventId}`,
    ).toBe(job.dedupeKey);
  }
}

function expectMirrorContains(gate: Gate, sha: string): void {
  const mirror = gate.repo.mirrorPath ?? "";
  expect(mirror).not.toBe("");
  expect(() =>
    execFileSync("git", ["-C", mirror, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
    }),
  ).not.toThrow();
}

function pullAt(
  gate: Gate,
  options: { number: number; headSha: string; baseHeadSha: string },
): PullFixture {
  return makePull({
    number: options.number,
    headSha: options.headSha,
    baseHeadSha: options.baseHeadSha,
    updatedAt: new Date(
      gate.clock.now().getTime() - PR_UPDATED_OFFSET_MS,
    ).toISOString(),
  });
}

// ── C properties: one event per observable change ───────────────────────────

describe("phase C — every observable change is recorded once", () => {
  test("commits, a merge, a force-push gap and a rename each become one record per observed change", async () => {
    const gate = await createGate();

    // The fixture's head (a merge commit on main) is the first observable
    // change: a baseline, never a replay of history (AC-UPD-02).
    const baselineHead = gate.remote.head("main");
    const first = await gate.tick();
    expect(first.discovered).toBe(1);
    expect(first.enqueued).toBe(0);
    expect(gate.events()).toHaveLength(1);
    expect(gate.events()[0]).toMatchObject({
      kind: "baseline",
      headSha: baselineHead,
      jobId: null,
    });
    expect(gate.cursor(DEFAULT_BRANCH_STREAM)).toMatchObject({
      headSha: baselineHead,
      branch: "main",
      lastPollAt: gate.clock.now().toISOString(),
    });

    let events = 1;
    let jobs = 0;
    const check = (): void => {
      expect(gate.events()).toHaveLength(events);
      expect(gate.changeJobs()).toHaveLength(jobs);
      expectNoDuplicateEvents(gate);
    };
    check();

    // One direct commit on the default branch.
    gate.remote.write("src/gate-one.ts", "export const one = 1;\n");
    const commitOne = gate.remote.commit("feat: gate one");
    await gate.sync();
    await gate.tick();
    events += 1;
    jobs += 1;
    check();
    expectMirrorContains(gate, commitOne);
    await gate.runPending();
    const one = gate.events().find((event) => event.headSha === commitOne)!;
    expect(one).toMatchObject({ kind: "commit", state: "published" });

    // A merge commit is one event; branch commits stay associated, not events.
    gate.remote.createBranch("gate-merge");
    gate.remote.write("src/gate-merged.ts", "export const merged = 1;\n");
    const branchCommit = gate.remote.commit("feat: gate merged");
    gate.remote.checkout("main");
    const mergeCommit = gate.remote.merge("gate-merge", "merge: gate merge");
    await gate.sync();
    await gate.tick();
    events += 1;
    jobs += 1;
    check();
    const merge = gate.events().find((event) => event.headSha === mergeCommit)!;
    expect(merge.kind).toBe("merge_commit");
    expect(merge.payload.commit?.associatedCommits).toContain(branchCommit);
    expect(gate.events().some((event) => event.headSha === branchCommit)).toBe(
      false,
    );
    await gate.runPending();

    // A force-push gap is an observable change too: `history_gap` + baseline.
    const beforeGap = gate.cursor(DEFAULT_BRANCH_STREAM)!.headSha!;
    const gapTick = await (async () => {
      gate.remote.orphan("gate-rewritten");
      gate.remote.write(
        "src/gate-rewritten.ts",
        "export const rewritten = 1;\n",
      );
      const rewritten = gate.remote.commit("rewrite: new root");
      gate.remote.forceBranch("main", rewritten);
      gate.remote.checkout("main");
      await gate.sync({ force: true });
      const result = await gate.tick();
      return { rewritten, result };
    })();
    expect(gapTick.result.gaps).toBe(1);
    events += 2;
    jobs += 0;
    check();
    const gap = gate.events().find((event) => event.kind === "history_gap")!;
    expect(gap).toMatchObject({
      gapReason: "history_gap",
      baseSha: beforeGap,
      headSha: gapTick.rewritten,
    });
    expect(gap.payload.comparison).toEqual({
      baseSha: beforeGap,
      headSha: gapTick.rewritten,
    });
    expect(gate.cursor(DEFAULT_BRANCH_STREAM)?.lastGapSha).toBe(beforeGap);

    // A commit after the gap, then a branch rename with a new head:
    // `branch_switch` + a fresh baseline, and no commit replay.
    gate.remote.write("src/gate-two.ts", "export const two = 2;\n");
    const commitTwo = gate.remote.commit("feat: gate two");
    await gate.sync();
    await gate.tick();
    events += 1;
    jobs += 1;
    check();
    await gate.runPending();
    expect(
      gate.events().find((event) => event.headSha === commitTwo)?.state,
    ).toBe("published");

    gate.remote.write("src/gate-three.ts", "export const three = 3;\n");
    const commitThree = gate.remote.commit("feat: gate three");
    gate.remote.renameBranch("main", "trunk");
    await gate.sync({ renameTo: "trunk" });
    await gate.tick();
    events += 2;
    jobs += 0;
    check();

    const branchSwitch = gate
      .events()
      .find((event) => event.kind === "branch_switch")!;
    expect(branchSwitch.payload).toMatchObject({
      fromBranch: "main",
      toBranch: "trunk",
    });
    expect(
      gate
        .events()
        .some((event) => event.kind === "baseline" && event.headSha === commitThree),
    ).toBe(true);
    // The commit that arrived with the rename is not replayed as a commit.
    expect(
      gate
        .events()
        .some(
          (event) => event.headSha === commitThree && event.kind === "commit",
        ),
    ).toBe(false);
    expect(gate.events().filter((event) => event.kind === "commit")).toHaveLength(
      2,
    );
    expect(gate.cursor(DEFAULT_BRANCH_STREAM)).toMatchObject({
      headSha: commitThree,
      branch: "trunk",
      lastPollAt: gate.clock.now().toISOString(),
    });
    expect(gate.cursor(DEFAULT_BRANCH_STREAM, "published")).toBeNull();

    // A quiet tick discovers nothing new.
    const quiet = await gate.tick();
    expect(quiet.discovered).toBe(0);
    expect(gate.events()).toHaveLength(events);

    // The fake server only ever saw GET/HEAD (AC-UPD-25).
    expect(
      gate.fake.requests.every(
        (request) => request.method === "GET" || request.method === "HEAD",
      ),
    ).toBe(true);
  }, 180_000);
});

// ── C properties: the pull-request stream ───────────────────────────────────

describe("phase C — the pull-request stream", () => {
  test("repeated delivery, head and base updates, stream independence and preview separation", async () => {
    const gate = await createGate();
    const base = gate.remote.head("main");
    const first = await gate.tick();
    expect(first.discovered).toBe(1);
    expect(gate.events()).toHaveLength(1);
    let events = 1;
    let jobs = 0;

    gate.remote.createBranch("gate-pr");
    gate.remote.write(PREVIEW_PATH, "export const prPreview = 1;\n");
    const headOne = gate.remote.commit("feat: pr preview one");
    gate.remote.checkout("main");

    gate.clock.advance(TICK_MS);
    gate.setPulls([pullAt(gate, { number: 42, headSha: headOne, baseHeadSha: base })]);
    await gate.sync();
    await gate.tick();
    events += 1;
    jobs += 1;
    expect(gate.events()).toHaveLength(events);
    expect(gate.changeJobs()).toHaveLength(jobs);
    expectNoDuplicateEvents(gate);
    await gate.runPending();

    const prEvents = (): ChangeRecord[] =>
      gate.events().filter((event) => event.kind === "pull_request");
    expect(prEvents()).toHaveLength(1);
    expect(prEvents()[0]).toMatchObject({
      state: "published",
      headSha: headOne,
      baseContextSha: base,
    });
    expect(
      gate.repos.jobs.byId(prEvents()[0].jobId!)?.outputGenerationId,
    ).not.toBeNull();

    // Repeated delivery in the next overlapping window: one row, one job.
    gate.clock.advance(TICK_MS);
    const repeat = await gate.tick();
    expect(repeat.discovered).toBe(1);
    expect(repeat.enqueued).toBe(0);
    expect(gate.events()).toHaveLength(events);
    expect(gate.changeJobs()).toHaveLength(jobs);
    expect(prEvents()).toHaveLength(1);

    // PR update: a new head is a new observable change.
    gate.remote.checkout("gate-pr");
    gate.remote.write(PREVIEW_PATH, "export const prPreview = 2;\n");
    const headTwo = gate.remote.commit("feat: pr preview two");
    gate.remote.checkout("main");
    gate.clock.advance(TICK_MS);
    gate.setPulls([pullAt(gate, { number: 42, headSha: headTwo, baseHeadSha: base })]);
    await gate.sync();
    await gate.tick();
    events += 1;
    jobs += 1;
    expect(gate.events()).toHaveLength(events);
    expectNoDuplicateEvents(gate);
    await gate.runPending();
    expect(prEvents()).toHaveLength(2);
    expect(prEvents().map((event) => event.headSha)).toContain(headTwo);

    // Both streams move in one tick: a default-branch commit and a PR whose
    // head is unchanged but whose base moved. Neither blocks the other.
    gate.remote.write("src/main-advance.ts", "export const advance = 1;\n");
    const advancedBase = gate.remote.commit("feat: advance main");
    gate.clock.advance(TICK_MS);
    gate.setPulls([
      pullAt(gate, { number: 42, headSha: headTwo, baseHeadSha: advancedBase }),
    ]);
    const mainCursorBefore = gate.cursor(DEFAULT_BRANCH_STREAM);
    const prCursorBefore = gate.cursor(PULL_REQUEST_DISCOVERY_STREAM);
    await gate.sync();
    await gate.tick();
    events += 2;
    jobs += 2;
    expect(gate.events()).toHaveLength(events);
    expect(gate.changeJobs()).toHaveLength(jobs);
    expectNoDuplicateEvents(gate);
    expect(gate.cursor(DEFAULT_BRANCH_STREAM)).not.toEqual(mainCursorBefore);
    expect(gate.cursor(PULL_REQUEST_DISCOVERY_STREAM)).not.toEqual(
      prCursorBefore,
    );
    await gate.runPending({ streamKind: "default_branch" });

    const mainEvent = gate
      .events()
      .find((event) => event.headSha === advancedBase)!;
    expect(mainEvent.kind).toBe("commit");

    // Unchanged head, moved base: the PR produces a *second* event and job
    // because `base_context_sha` is part of both keys. Only the default-branch
    // job is executed here; a base-only move keeps the same merge-base, so the
    // preview generation identity is unchanged (the event/job identity is what
    // this gate verifies, not lesson reuse).
    const mergeBase = gate.remote.git(["merge-base", advancedBase, headTwo]);
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/u);
    const baseChangeEvent = prEvents().find(
      (event) => event.baseContextSha === advancedBase,
    )!;
    const earlierPrEvent = prEvents().find(
      (event) => event.headSha === headTwo && event.baseContextSha === mergeBase,
    )!;
    expect(baseChangeEvent).toMatchObject({
      headSha: headTwo,
      baseSha: mergeBase,
      mergeBaseSha: mergeBase,
      baseContextSha: advancedBase,
    });
    expect(earlierPrEvent).toBeDefined();
    expect(baseChangeEvent.jobId).not.toBe(earlierPrEvent.jobId);
    expect(
      gate.repos.jobs.byId(baseChangeEvent.jobId!)!.dedupeKey,
    ).not.toBe(gate.repos.jobs.byId(earlierPrEvent.jobId!)!.dedupeKey);
    expect(prEvents()).toHaveLength(3);

    // Preview separation: distinct head and base records, and the preview
    // generation is keyed to the PR head while main is keyed to its own commit.
    expect(baseChangeEvent.headSha).not.toBe(mainEvent.headSha);
    expect(baseChangeEvent.baseContextSha).not.toBe(mainEvent.baseContextSha);
    const prJob = gate.repos.jobs.byId(earlierPrEvent.jobId!)!;
    const mainJob = gate.repos.jobs.byId(mainEvent.jobId!)!;
    expect(prJob.outputGenerationId).not.toBeNull();
    expect(mainJob.outputGenerationId).not.toBeNull();
    expect(prJob.outputGenerationId).not.toBe(mainJob.outputGenerationId);
    const prGeneration = gate.repos.generations.byId(
      prJob.outputGenerationId!,
    )!;
    const mainGeneration = gate.repos.generations.byId(
      mainJob.outputGenerationId!,
    )!;
    expect(prGeneration.kind).toBe("change");
    expect(mainGeneration.kind).toBe("change");
    expect(prGeneration.commitSha).toBe(headTwo);
    expect(mainGeneration.commitSha).toBe(advancedBase);
    expect(prGeneration.generationId).not.toBe(mainGeneration.generationId);

    // The PR generation's cache key proves the preview was built from the PR
    // head with the merge-base as its base context (§3.6).
    expect(earlierPrEvent.baseSha).toBe(mergeBase);
    const config = gateConfig();
    expect(prGeneration.cacheKey).toBe(
      computeCacheKey({
        repoIdentity: gate.repo.identity,
        targetCommitSha: headTwo,
        baseContextSha: mergeBase,
        scopeHash: gate.repos.projects.byId(gate.projectId)!.scope.hash,
        generationConfigHash: computeConfigHash(config),
        promptTemplateVersion: config.promptTemplateVersion,
        preferencesVersion: gate.repos.prefs.version(),
        upstreamVersion: UPSTREAM_VERSION,
      }),
    );
    expect(mainGeneration.cacheKey).not.toBe(prGeneration.cacheKey);

    // Preview content comes from the head, not from the default branch, and
    // the diff runs merge-base → head.
    const prBuild = gate.builds.find(
      (build) => build.commitSha === headTwo && build.baseSha === mergeBase,
    )!;
    expect(prBuild.headHasPreview).toBe(true);
    expect(prBuild.previewText).toContain("prPreview = 2");
    expect(prBuild.diffPaths).toContain(PREVIEW_PATH);
    expect(prBuild.baseSha).toBe(mergeBase);
    const mainBuild = gate.builds.find(
      (build) => build.commitSha === advancedBase,
    )!;
    expect(mainBuild.headHasPreview).toBe(false);
    expect(mainBuild.diffPaths).not.toContain(PREVIEW_PATH);

    // The two discovery cursors are separate rows and both moved.
    expect(mainCursorBefore).not.toBeNull();
    expect(prCursorBefore).not.toBeNull();
    expect(mainCursorBefore!.streamKind).toBe("default_branch");
    expect(prCursorBefore!.streamKind).toBe("pull_request");
    expect(gate.cursor(PULL_REQUEST_DISCOVERY_STREAM)).toMatchObject({
      page: null,
      lastPollAt: gate.clock.now().toISOString(),
    });
    expect(gate.cursor(PULL_REQUEST_DISCOVERY_STREAM, "published")).toBeNull();
    expect(gate.cursor(DEFAULT_BRANCH_STREAM, "published")).toBeNull();
  }, 240_000);
});

// ── C properties: failure isolation ─────────────────────────────────────────

describe("phase C — failure isolation", () => {
  test("a failed analysis keeps its event, parks its successor and leaves the other stream publishing", async () => {
    const gate = await createGate();
    await gate.tick();
    expect(gate.events()).toHaveLength(1);

    // A first, successful default-branch change.
    gate.remote.write("src/ok.ts", "export const ok = 1;\n");
    const okSha = gate.remote.commit("feat: ok");
    await gate.sync();
    await gate.tick();
    await gate.runPending();
    expect(gate.events().find((event) => event.headSha === okSha)?.state).toBe(
      "published",
    );

    const publishedBefore = {
      defaultBranch: gate.cursor(DEFAULT_BRANCH_STREAM, "published"),
      pullRequest: gate.cursor(PULL_REQUEST_DISCOVERY_STREAM, "published"),
    };
    const eventsBefore = gate.events().length;
    const jobsBefore = gate.changeJobs().length;

    // The next change fails, then a successor arrives in the same stream.
    gate.remote.write("src/broken.ts", "export const broken = 1;\n");
    const brokenSha = gate.remote.commit("feat: broken");
    await gate.sync();
    await gate.tick();
    gate.setFailForSha(brokenSha);
    await gate.runPending();
    gate.setFailForSha(null);

    // A same-stream successor plus a PR in the other stream, in one tick.
    gate.remote.write("src/successor.ts", "export const successor = 1;\n");
    const successorSha = gate.remote.commit("feat: successor");
    gate.remote.createBranch("gate-pr");
    gate.remote.write("src/pr-other.ts", "export const other = 1;\n");
    const prHead = gate.remote.commit("feat: other stream");
    gate.remote.checkout("main");
    gate.clock.advance(TICK_MS);
    gate.setPulls([
      pullAt(gate, { number: 7, headSha: prHead, baseHeadSha: successorSha }),
    ]);
    await gate.sync();
    await gate.tick();
    await gate.runPending();

    // The failed event is retained and its job failed; nothing was deleted.
    const broken = gate.events().find((event) => event.headSha === brokenSha)!;
    expect(broken).toBeDefined();
    expect(broken.state).toBe("failed");
    expect(gate.repos.jobs.byId(broken.jobId!)?.state).toBe("failed");

    // The successor in the same stream waits; it never got a job.
    const successor = gate
      .events()
      .find((event) => event.headSha === successorSha)!;
    expect(successor).toMatchObject({ state: "waiting", jobId: null });

    // The published cursor never advances on failure (for either stream).
    expect(gate.cursor(DEFAULT_BRANCH_STREAM, "published")).toEqual(
      publishedBefore.defaultBranch,
    );
    expect(gate.cursor(PULL_REQUEST_DISCOVERY_STREAM, "published")).toEqual(
      publishedBefore.pullRequest,
    );

    // The other stream is not blocked: the PR event published.
    const prEvent = gate
      .events()
      .find((event) => event.kind === "pull_request")!;
    expect(prEvent.baseContextSha).toBe(successorSha);
    expect(prEvent.state).toBe("published");
    expect(
      gate.repos.jobs.byId(prEvent.jobId!)?.outputGenerationId,
    ).not.toBeNull();

    // Discovery still advanced past the failed event, so a restart resumes
    // without re-discovering it.
    expect(gate.cursor(DEFAULT_BRANCH_STREAM)?.headSha).toBe(successorSha);
    // The broken job and the PR job were added; the successor got none.
    expect(gate.changeJobs()).toHaveLength(jobsBefore + 2);
    expect(gate.events()).toHaveLength(eventsBefore + 3);
    expectNoDuplicateEvents(gate);
  }, 240_000);
});

// ── C properties: restart ───────────────────────────────────────────────────

describe("phase C — restart", () => {
  test("re-composing over the same data dir leaves the counts unchanged and adds no duplicate job", async () => {
    const clock = createClock(FIXED_NOW);
    const first = await createGate({ clock });
    await first.tick();

    first.remote.write("src/restart.ts", "export const restart = 1;\n");
    const sha = first.remote.commit("feat: restart");
    await first.sync();
    await first.tick();
    await first.runPending();

    const eventsBefore = first.events().length;
    const jobsBefore = first.changeJobs().length;
    const generationsBefore = first.repos.generations.listByProject(
      first.projectId,
    ).length;
    expect(eventsBefore).toBe(2);
    expect(jobsBefore).toBe(1);
    expect(generationsBefore).toBe(1);
    const eventIdsBefore = first.events()
      .map((event) => event.eventId)
      .sort();
    const jobIdsBefore = first.changeJobs()
      .map((job) => job.jobId)
      .sort();

    // A genuine restart: the SQLite handle and every service are new; only the
    // data directory, the mirror and the working clone survive.
    const remote = first.remote;
    await first.close();
    const restarted = await createGate({ clock, remote });

    const quiet = await restarted.tick();
    expect(quiet.enqueued).toBe(0);
    expect(restarted.events()).toHaveLength(eventsBefore);
    expect(restarted.changeJobs()).toHaveLength(jobsBefore);
    expect(restarted.events().map((event) => event.eventId).sort()).toEqual(
      eventIdsBefore,
    );
    expect(restarted.changeJobs().map((job) => job.jobId).sort()).toEqual(
      jobIdsBefore,
    );
    expect(
      restarted.repos.generations.listByProject(restarted.projectId),
    ).toHaveLength(generationsBefore);
    expectNoDuplicateEvents(restarted);
    expect(restarted.cursor(DEFAULT_BRANCH_STREAM)?.headSha).toBe(sha);
    expect(restarted.cursor(DEFAULT_BRANCH_STREAM, "published")).toBeNull();
  }, 180_000);
});

// ── C properties: the reachable inbox ───────────────────────────────────────

describe("phase C — the change inbox", () => {
  test("walking GET /api/projects/:id/changes reaches every discovered event exactly once", async () => {
    const gate = await createGate();
    await gate.tick();

    gate.remote.write("src/inbox-one.ts", "export const one = 1;\n");
    gate.remote.commit("feat: inbox one");
    gate.remote.write("src/inbox-two.ts", "export const two = 2;\n");
    gate.remote.commit("feat: inbox two");
    await gate.sync();
    await gate.tick();
    await gate.runPending();

    const stored = gate.events();
    expect(stored).toHaveLength(3);

    const server = await gate.startChangesServer();
    const harness = await startHarness({ baseUrl: server.url });
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const query = `/api/projects/${gate.projectId}/changes?limit=1${
          cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
        }`;
        const response = await harness.request(query);
        expect(response.status).toBe(200);
        const body = response.json as ChangeListView;
        for (const item of body.items) {
          expect(seen).not.toContain(item.changeId);
          seen.push(item.changeId);
        }
        if (body.next === null) break;
        cursor = body.next;
      }
      expect(seen).toHaveLength(stored.length);
      expect(new Set(seen)).toEqual(
        new Set(stored.map((event) => event.eventId)),
      );
    } finally {
      await harness.close();
      await server.close();
    }
  }, 180_000);
});

// ── phase-check C stage (AC-GATE-C / ordering) ──────────────────────────────

function runPhaseCheck(
  args: string[],
  options: { timeoutMs?: number } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [PHASE_CHECK, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 20 * 60 * 1000,
    windowsHide: true,
  });
}

function parsedStdout(
  result: ReturnType<typeof spawnSync>,
): Record<string, unknown> {
  expect(typeof result.stdout).toBe("string");
  return JSON.parse(String(result.stdout).trim()) as Record<string, unknown>;
}

function runScriptModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(PHASE_CHECK).href;
  const source = `import * as phaseCheck from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(${expression}));\n`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout)) as unknown;
}

describe.skipIf(INSIDE_PHASE_CHECK)("phase-check C stage", () => {
  test("C is registered after B with its own gate test and the updates suite", () => {
    const seam = runScriptModule(
      "({ phases: phaseCheck.STAGES.map((stage) => stage.phase), testFiles: phaseCheck.STAGES.map((stage) => stage.testFile), suites: phaseCheck.STAGES.map((stage) => stage.suites.map((suite) => suite.name)) })",
    ) as { phases: string[]; testFiles: string[]; suites: string[][] };

    expect(seam.phases.slice(0, 3)).toEqual(["A", "B", "C"]);
    expect(seam.testFiles[2]).toBe("test/learning/phase/c-gate.test.ts");
    expect(seam.suites[2]).toContain("c-gate");
    expect(seam.suites[2]).toContain("updates");
    // C never rewrites A's or B's entries.
    expect(seam.testFiles[0]).toBe("test/learning/phase/a-gate.test.ts");
    expect(seam.testFiles[1]).toBe("test/learning/phase/b-gate.test.ts");
    expect(seam.suites[0]).toContain("a-gate");
    expect(seam.suites[1]).toEqual(["b-gate"]);

    // The ordering invariant itself: a red C blocks D.
    const order = runScriptModule(
      "phaseCheck.checkOrder([{phase:'A',passed:true},{phase:'B',passed:true},{phase:'C',passed:false},{phase:'D',pending:true}])",
    ) as Record<string, unknown>;
    expect(order).toMatchObject({ ok: false, brokenBy: "C" });
    expect(order).not.toHaveProperty("greenWhileRed");
  }, 60_000);

  test(
    "--through=D exits non-zero while C is red",
    () => {
      const result = runPhaseCheck(["--through=D", "--simulate", "C=fail"], {
        timeoutMs: 30 * 60 * 1000,
      });
      expect(result.status).not.toBe(0);
      const json = parsedStdout(result);
      expect(json.phase).toBe("D");
      expect(json.passed).toBe(false);
      expect(json.failed).toMatchObject({ phase: "C", simulated: true });
      expect(String(result.stderr)).toContain("phase C is red");
      expect(String(result.stdout)).not.toContain('"passed":true');
      const stages = json.stages as { name: string }[];
      expect(stages.some((stage) => stage.name === "c-gate")).toBe(false);
    },
    35 * 60 * 1000,
  );
});
