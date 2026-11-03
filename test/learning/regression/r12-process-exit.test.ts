/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * AC-R12-02: a hard kill during a change generation leaves the work
 * recoverable. The real process is restarted against the same data directory:
 * the interrupted job comes back as `interrupted` with its original `job_id`,
 * the discovered event count is unchanged, and re-running discovery creates no
 * duplicate job.
 *
 * The child process runs the production `JobRunner` and blocks inside the
 * change lesson builder, so the kill lands while a job is genuinely `running`.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  repoIdFromIdentity,
  type GithubClient,
  type JobRunner,
  type JobState,
  type ProjectId,
  type WatchDeps,
} from "../../../src/learning/contracts/index.ts";
import { DEFAULT_WATCH_INTERVAL_MS } from "../../../src/learning/config/defaults.ts";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createDiscoveryService } from "../../../src/learning/updates/discovery.ts";
import { runWatchTick } from "../../../src/learning/updates/watch.ts";
import { fixedClock } from "../projects/harness.ts";
import {
  createGitRepo,
  createRealRunner,
  type GitRepo,
  type UpdateHarness,
} from "../updates/harness.ts";

const CLOCK = "2024-06-01T01:00:00.000Z";
const PROJECT_ID = "p_r12_process" as ProjectId;
const ALL_JOB_STATES: JobState[] = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

let gitRepo: GitRepo | undefined;

afterEach(() => {
  gitRepo?.close();
  gitRepo = undefined;
});

interface Opened {
  paths: ReturnType<typeof resolveDataPaths>;
  clock: ReturnType<typeof fixedClock>;
  db: ReturnType<typeof openDatabase>;
  repos: ReturnType<typeof createRepositories>;
}

async function open(dataDir: string): Promise<Opened> {
  const paths = resolveDataPaths({
    ...process.env,
    CODETRAIL_DATA_DIR: dataDir,
  });
  await ensureDataDir(paths);
  const clock = fixedClock(CLOCK);
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  return { paths, clock, db, repos: createRepositories(db) };
}

/** A read-only GitHub client whose only truth is the local mirror's HEAD. */
function githubFor(repo: GitRepo): GithubClient {
  return {
    async defaultBranch() {
      return "main";
    },
    async commitsSince() {
      const sha = repo.head("main");
      return {
        items: [
          {
            sha,
            parents: repo.parents(sha),
            message: "",
            authoredAt: "",
            committedAt: "",
          },
        ],
        nextPage: null,
      };
    },
    async pullRequests() {
      return { items: [], nextPage: null };
    },
    async pullRequest() {
      throw new Error("unused by the default-branch stream");
    },
    async rateLimit() {
      return null;
    },
  };
}

function noopRunner(): JobRunner {
  const fail = async (): Promise<never> => {
    throw new Error("the watch tick never runs a job");
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

function depsFor(opened: Opened, github: GithubClient): WatchDeps {
  return {
    db: opened.db,
    repos: opened.repos,
    clock: opened.clock,
    github,
    discovery: createDiscoveryService({
      db: opened.db,
      repos: opened.repos,
      clock: opened.clock,
      github,
      paths: opened.paths,
    }),
    jobRunner: noopRunner(),
    intervalMs: DEFAULT_WATCH_INTERVAL_MS,
  };
}

function moduleUrl(relative: string): string {
  return JSON.stringify(pathToFileURL(path.join(process.cwd(), relative)).href);
}

/** The child script: a real JobRunner that blocks inside the lesson builder. */
function childSource(): string {
  return `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDataPaths, ensureDataDir } from ${moduleUrl("src/learning/config/paths.ts")};
import { openDatabase, migrate, createRepositories } from ${moduleUrl("src/learning/store/index.ts")};
import { createClock } from ${moduleUrl("src/learning/testing/clock.ts")};
import { createJobRunner } from ${moduleUrl("src/learning/api/jobs/runner.ts")};
import { createUsageMeter } from ${moduleUrl("src/learning/api/jobs/usage.ts")};
import { createSourceRegistry } from ${moduleUrl("src/learning/evidence/registry.ts")};

const dataDir = process.env.CODETRAIL_DATA_DIR;
const marker = process.env.CODETRAIL_READY_FILE;
if (!dataDir || !marker) throw new Error("data dir and marker are required");
const paths = resolveDataPaths({ ...process.env, CODETRAIL_DATA_DIR: dataDir });
await ensureDataDir(paths);
const clock = createClock(${JSON.stringify(CLOCK)});
const db = openDatabase({ file: paths.db, clock });
migrate(db);
const repos = createRepositories(db);
const usage = createUsageMeter({ db, repos, clock });
const registry = createSourceRegistry({ clock, sources: repos.sources, generations: repos.generations });
const job = repos.jobs.listByState(["queued"]).find((entry) => entry.kind === "change_analysis");
if (!job) {
  process.stderr.write("no queued change job\\n");
  process.exit(2);
}
const workRoot = path.join(dataDir, "r12-work");
mkdirSync(workRoot, { recursive: true });
const snapshotService = {
  async resolve(_repoId, ref) { return ref; },
  async ensure(repoId, sha) {
    return { repoId, commitSha: sha, treeHash: "tree:" + sha, worktreePath: workRoot, resolvedAt: clock.now().toISOString() };
  },
  async readFile() { return ""; },
  async listFiles() { return []; },
  async coverage(_snap, _scope, generationId) {
    return {
      generationId,
      commitSha: job.payload.headSha,
      complete: true,
      analyzed: [],
      gaps: [],
      counts: { totalFiles: 0, analyzedFiles: 0, excludedFiles: 0 },
      languages: { byLanguage: [], preferredCoverageOk: false },
    };
  },
};
const publisher = {
  buildWorkspace(id) {
    const stagingDir = path.join(paths.staging, id);
    const knowledgeDir = path.join(stagingDir, "knowledge");
    return { stagingDir, treeDir: path.join(stagingDir, "tree"), knowledgeDir, lessonsDir: path.join(knowledgeDir, "lessons") };
  },
  async seal() { throw new Error("unreachable"); },
  async publishAtomic() { throw new Error("unreachable"); },
  async gc() { return { removedWorkspaces: [], removedKnowledge: [], keptPublished: 0, keptInFlight: 0, bytesFreed: 0 }; },
};
const lessons = {
  async buildChangeLesson() {
    writeFileSync(marker, "ready");
    await new Promise(() => {});
  },
  async buildResearchLessons() { throw new Error("unreachable"); },
  async buildComparisonLesson() { throw new Error("unreachable"); },
};
const model = {
  modelId: "blocked",
  settings: { provider: "blocked", model: "blocked", maxOutputTokens: 1, temperature: 0, pricing: null, quota: { maxCalls: 100, maxInputTokens: 100000, maxOutputTokens: 100000 } },
  chat: () => ({ invoke: async () => ({ content: "" }) }),
  estimate: () => ({ calls: 1, tokens: 10 }),
};
const upstream = {
  async run() { return { skipped: false, sourceChanged: true }; },
  sourceFingerprint: async () => "fp",
  treeHashOfWorktree: async () => "tree",
  changedPaths: async () => [],
  lastUpdate: async () => null,
  pageManifest: async () => null,
};
const external = {
  fetchExact: async () => ({ ok: false, status: "source_missing", reason: "not_found" }),
  cached: async () => null,
};
const runner = createJobRunner({ db, repos, paths, clock, snapshotService, publisher, upstream, lessons, model, usage, registry, external });
// The persisted job is picked up through the documented retry path, exactly as
// a process does after recoverInterrupted().
repos.jobs.transition(job.jobId, ["queued"], "interrupted", {
  errorCode: "interrupted",
  finishedAt: clock.now().toISOString(),
});
await runner.retry(job.jobId);
await runner.drain();
`;
}

function waitForMarker(file: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`child never signalled readiness at ${file}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

describe("AC-R12-02 — process exit", () => {
  it("restarts with an interrupted, recoverable job and no duplicate", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    gitRepo = createGitRepo();
    gitRepo.write("src/app.ts", "export const value = 1;\n");
    gitRepo.commit("chore: initial");

    const opened = await open(dataDir);
    opened.repos.repos.upsert({
      repoId: repoIdFromIdentity("github:acme/widgets"),
      identity: "github:acme/widgets",
      kind: "github",
      mirrorPath: gitRepo.path,
      remoteUrl: "https://github.com/acme/widgets.git",
      createdAt: opened.clock.now().toISOString(),
    });
    const repoId = repoIdFromIdentity("github:acme/widgets");
    opened.repos.projects.insert({
      projectId: PROJECT_ID,
      repoId,
      kind: "github",
      displayName: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
      defaultBranch: "main",
      scope: {
        include: ["**/*.ts"],
        exclude: [],
        maxFiles: 5000,
        maxFileBytes: 5 * 1024 * 1024,
        hash: "scope:r12",
      },
      watchEnabled: true,
      createdAt: opened.clock.now().toISOString(),
      deletedAt: null,
    });

    const github = githubFor(gitRepo);
    const deps = depsFor(opened, github);
    await runWatchTick(deps, PROJECT_ID); // baseline
    gitRepo.write("src/feature.ts", "export const feature = 1;\n");
    const head = gitRepo.commit("feat: feature");
    await runWatchTick(deps, PROJECT_ID); // event + queued job

    const eventsBefore = opened.repos.changes.page(
      PROJECT_ID,
      null,
      1000,
    ).items;
    const jobsBefore = opened.repos.jobs.listByProject(
      PROJECT_ID,
      ALL_JOB_STATES,
    );
    expect(eventsBefore.length).toBe(2);
    expect(jobsBefore).toHaveLength(1);
    const jobId = jobsBefore[0].jobId;
    opened.db.close();

    // Real child process; killed while `buildChangeLesson` is running.
    const childFile = path.join(dataDir, "r12-child.mts");
    writeFileSync(childFile, childSource(), "utf8");
    const marker = path.join(dataDir, "r12-ready");
    const child = spawn(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        childFile,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODETRAIL_DATA_DIR: dataDir,
          CODETRAIL_READY_FILE: marker,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    try {
      await Promise.race([
        waitForMarker(marker),
        exited.then((code) => {
          throw new Error(
            `child exited early with code ${String(code)}\n${stderr}`,
          );
        }),
      ]);
    } catch (error) {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
      throw new Error(`${(error as Error).message}\n${stderr}`, {
        cause: error,
      });
    }
    child.kill("SIGKILL");
    const signalExit = await exited;
    expect(signalExit === null || signalExit !== 0).toBe(true);

    // Restart against the same data directory.
    const restarted = await open(dataDir);
    const { runner } = createRealRunner({
      db: restarted.db,
      repos: restarted.repos,
      paths: restarted.paths,
      clock: restarted.clock,
    } as unknown as UpdateHarness);
    const recovered = await runner.recoverInterrupted();
    expect(recovered).toBe(1);

    const interrupted = await runner.get(jobId);
    expect(interrupted?.jobId).toBe(jobId);
    expect(interrupted?.state).toBe("interrupted");
    expect(interrupted?.errorCode).toBe("interrupted");

    // The discovered event count is unchanged and no duplicate job exists.
    expect(
      restarted.repos.changes.page(PROJECT_ID, null, 1000).items.length,
    ).toBe(eventsBefore.length);
    expect(
      restarted.repos.jobs.listByProject(PROJECT_ID, ALL_JOB_STATES),
    ).toHaveLength(1);

    // A restarted tick has nothing left to discover.
    const github2 = githubFor(gitRepo);
    const tick = await runWatchTick(depsFor(restarted, github2), PROJECT_ID);
    expect(tick.discovered).toBe(0);
    expect(
      restarted.repos.changes.page(PROJECT_ID, null, 1000).items.length,
    ).toBe(eventsBefore.length);
    expect(
      restarted.repos.jobs.listByProject(PROJECT_ID, ALL_JOB_STATES),
    ).toHaveLength(1);

    // Recoverable: the same job id retries (attempt 2) rather than a new job.
    const retried = await runner.retry(jobId);
    expect(retried.jobId).toBe(jobId);
    expect(retried.attempt).toBe(2);
    await runner.cancel(jobId);
    expect(
      restarted.repos.jobs.listByProject(PROJECT_ID, ALL_JOB_STATES),
    ).toHaveLength(1);
    expect(head).toBe(gitRepo.head("main"));
    restarted.db.close();
  }, 120_000);
});
