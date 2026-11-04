/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * Shared harness for the update/watch suites.
 *
 * Everything is real except the two seams a test must control: the GitHub API
 * (a deterministic in-process client) and the clock. The store, discovery,
 * diff and watch services are the production implementations, and the mirror
 * is a real Git repository, so first-parent walking and local diffs are
 * exercised as shipped. Ticks are driven directly; no test sleeps.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  repoIdFromIdentity,
  type CommitMeta,
  type Database,
  type DataPaths,
  type DiscoveryService,
  type GithubClient,
  type GithubPage,
  type JobRunner,
  type ProjectId,
  type ProjectRecord,
  type PullRequestMeta,
  type RepoRecord,
  type Repositories,
  type WatchDeps,
  type WatchTickResult,
} from "../../../src/learning/contracts/index.ts";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  DISCOVERY_DEFAULTS,
  PR_OVERLAP_MS,
} from "../../../src/learning/config/defaults.ts";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import {
  DEFAULT_BRANCH_STREAM,
  PULL_REQUEST_DISCOVERY_STREAM,
  createDiscoveryService,
} from "../../../src/learning/updates/discovery.ts";
import { runWatchTick } from "../../../src/learning/updates/watch.ts";
import { createJobRunner } from "../../../src/learning/api/jobs/runner.ts";
import { changeEventIdFromKey } from "../../../src/learning/contracts/index.ts";
import { fixedClock } from "../projects/harness.ts";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export interface GitRepo {
  path: string;
  git(args: string[], extraEnv?: NodeJS.ProcessEnv): string;
  write(relPath: string, content: string): void;
  remove(relPath: string): void;
  commit(message: string): string;
  merge(branch: string, message: string): string;
  checkout(branch: string): void;
  createBranch(name: string): void;
  deleteBranch(name: string): void;
  renameBranch(from: string, to: string): void;
  forceBranch(name: string, sha: string): void;
  head(branch?: string): string;
  parents(sha: string): string[];
  tree(sha: string): string;
  commitList(rev: string): string[];
  close(): void;
}

/** Creates a real (non-bare) Git repository with a deterministic identity. */
export function createGitRepo(): GitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-updates-git-"));
  let clockTick = 0;

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const date = new Date(
      Date.UTC(2024, 4, 1, 0, 0, 0) + clockTick * 60_000,
    ).toISOString();
    return {
      ...process.env,
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_CONFIG_SYSTEM: NULL_DEVICE,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Codetrail Tests",
      GIT_AUTHOR_EMAIL: "tests@codetrail.invalid",
      GIT_COMMITTER_NAME: "Codetrail Tests",
      GIT_COMMITTER_EMAIL: "tests@codetrail.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      ...extra,
    };
  };

  const git = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): string =>
    execFileSync(
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
        env: env(extraEnv),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

  git(["init"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);

  const write = (relPath: string, content: string): void => {
    const absolute = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  };

  const commit = (message: string): string => {
    clockTick += 1;
    git(["add", "-A"]);
    git(["commit", "--allow-empty", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };

  return {
    path: dir,
    git,
    write,
    remove(relPath: string): void {
      fs.rmSync(path.join(dir, relPath), { force: true, recursive: true });
    },
    commit,
    merge(branch: string, message: string): string {
      clockTick += 1;
      git(["merge", "--no-ff", branch, "-m", message]);
      return git(["rev-parse", "HEAD"]);
    },
    checkout(branch: string): void {
      git(["checkout", "-q", branch]);
    },
    createBranch(name: string): void {
      git(["checkout", "-q", "-b", name]);
    },
    deleteBranch(name: string): void {
      git(["branch", "-D", name]);
    },
    renameBranch(from: string, to: string): void {
      git(["branch", "-m", from, to]);
    },
    forceBranch(name: string, sha: string): void {
      git(["branch", "-f", name, sha]);
    },
    head(branch = "HEAD"): string {
      return git(["rev-parse", branch]);
    },
    parents(sha: string): string[] {
      const fields = git(["rev-list", "--parents", "-n", "1", sha]).split(
        /\s+/u,
      );
      return fields.slice(1).filter((value) => value !== "");
    },
    tree(sha: string): string {
      return git(["rev-parse", `${sha}^{tree}`]);
    },
    commitList(rev: string): string[] {
      return git(["rev-list", rev])
        .split("\n")
        .filter((value) => value !== "");
    },
    close(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A PR fixture in wire shape. */
export type PullFixture = PullRequestMeta;

export function makePull(
  overrides: Partial<PullFixture> & {
    number: number;
    headSha: string;
    baseHeadSha: string;
  },
): PullFixture {
  return {
    number: overrides.number,
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    title: overrides.title ?? `Pull request ${overrides.number}`,
    headRef: overrides.headRef ?? `feature-${overrides.number}`,
    headSha: overrides.headSha,
    baseRef: overrides.baseRef ?? "main",
    baseHeadSha: overrides.baseHeadSha,
    updatedAt: overrides.updatedAt ?? "2024-06-01T00:30:00.000Z",
    createdAt: overrides.createdAt ?? "2024-05-01T00:00:00.000Z",
  };
}

export interface StubGithub extends GithubClient {
  requests: { method: string; path: string; page: number | null }[];
  setBranch(branch: string): void;
  setPulls(pulls: PullFixture[]): void;
  branch(): string;
}

/**
 * A deterministic GitHub client backed by a real Git repository. It records
 * every request just like the HTTP fake, so it can also assert GET-only use.
 */
export function createStubGithub(options: {
  repo: GitRepo;
  branch?: string;
  pulls?: PullFixture[];
  perPage?: number;
}): StubGithub {
  let branch = options.branch ?? "main";
  let pulls = options.pulls ?? [];
  const requests: StubGithub["requests"] = [];
  const perPage = options.perPage ?? DISCOVERY_DEFAULTS.perPage;

  const commitMeta = (sha: string): CommitMeta => {
    const parents = options.repo.parents(sha);
    const date = options.repo.git(["show", "-s", "--format=%aI", sha]);
    return {
      sha,
      parents,
      message: options.repo.git(["show", "-s", "--format=%s", sha]),
      authoredAt: date,
      committedAt: date,
    };
  };

  return {
    requests,
    setBranch(next: string): void {
      branch = next;
    },
    setPulls(next: PullFixture[]): void {
      pulls = next;
    },
    branch(): string {
      return branch;
    },
    async defaultBranch(): Promise<string> {
      requests.push({ method: "GET", path: "/repos/acme/widgets", page: null });
      return branch;
    },
    async commitsSince(
      _ownerRepo: string,
      requestedBranch: string,
      _sinceIso: string,
      opts: { page: number; perPage: number },
    ): Promise<GithubPage<CommitMeta>> {
      requests.push({
        method: "GET",
        path: `/repos/acme/widgets/commits?sha=${requestedBranch}`,
        page: opts.page,
      });
      const shas = options.repo.commitList(requestedBranch);
      const start = (opts.page - 1) * opts.perPage;
      const items = shas.slice(start, start + opts.perPage).map(commitMeta);
      const nextPage =
        start + opts.perPage < shas.length ? opts.page + 1 : null;
      return { items, nextPage };
    },
    async pullRequests(
      _ownerRepo: string,
      opts: {
        state: "all";
        sort: "updated";
        direction: "desc";
        page: number;
        perPage: number;
      },
    ): Promise<GithubPage<PullRequestMeta>> {
      requests.push({
        method: "GET",
        path: `/repos/acme/widgets/pulls?state=${opts.state}&sort=${opts.sort}&direction=${opts.direction}`,
        page: opts.page,
      });
      const sorted = [...pulls].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      const effectivePerPage = opts.perPage || perPage;
      const start = (opts.page - 1) * effectivePerPage;
      const items = sorted.slice(start, start + effectivePerPage);
      const nextPage =
        start + effectivePerPage < sorted.length ? opts.page + 1 : null;
      return { items, nextPage };
    },
    async pullRequest(
      _ownerRepo: string,
      number: number,
    ): Promise<PullRequestMeta> {
      requests.push({
        method: "GET",
        path: `/repos/acme/widgets/pulls/${number}`,
        page: null,
      });
      const found = pulls.find((pull) => pull.number === number);
      if (found === undefined) {
        throw new Error(`pull request ${number} not found`);
      }
      return found;
    },
    async rateLimit(): Promise<{ remaining: number; resetAt: string } | null> {
      requests.push({ method: "GET", path: "/rate_limit", page: null });
      return null;
    },
  };
}

export interface UpdateHarness {
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: ReturnType<typeof fixedClock>;
  git: GitRepo;
  repo: RepoRecord;
  project: ProjectRecord;
  github: StubGithub;
  discovery: DiscoveryService;
  deps: WatchDeps;
  tick(): Promise<WatchTickResult>;
  events(): ReturnType<Repositories["changes"]["page"]>["items"];
  jobs(): ReturnType<Repositories["jobs"]["listByProject"]>;
  discoveryCursor(
    kind?: "default_branch" | "pull_request",
  ): ReturnType<Repositories["cursors"]["get"]>;
  close(): void;
}

const ALL_JOB_STATES = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

/** A `JobRunner` that refuses to run anything; discovery never calls it. */
function noopJobRunner(): JobRunner {
  const fail = async (): Promise<never> => {
    throw new Error("job runner is not used by discovery tests");
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

export async function createUpdateHarness(
  options: {
    now?: string;
    watchEnabled?: boolean;
    projectKind?: ProjectRecord["kind"];
    pulls?: PullFixture[];
  } = {},
): Promise<UpdateHarness> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);
  const clock = fixedClock(options.now ?? "2024-06-01T01:00:00.000Z");
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  const repos = createRepositories(db);

  const gitRepo = createGitRepo();
  gitRepo.write("src/app.ts", "export const value = 1;\n");
  gitRepo.commit("chore: initial commit");

  const identity = repoIdFromIdentity("github:acme/widgets");
  const repo: RepoRecord = repos.repos.upsert({
    repoId: identity,
    identity: "github:acme/widgets",
    kind: "github",
    mirrorPath: gitRepo.path,
    remoteUrl: "https://github.com/acme/widgets.git",
    createdAt: clock.now().toISOString(),
  });
  const project: ProjectRecord = {
    projectId: "p_updates_test" as ProjectId,
    repoId: repo.repoId,
    kind: options.projectKind ?? "github",
    displayName: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: options.watchEnabled ?? true,
    createdAt: clock.now().toISOString(),
    deletedAt: null,
  };
  repos.projects.insert(project);

  const github = createStubGithub({
    repo: gitRepo,
    branch: "main",
    pulls: options.pulls ?? [],
  });
  const discovery = createDiscoveryService({
    db,
    repos,
    clock,
    github,
    paths,
  });
  const deps: WatchDeps = {
    db,
    repos,
    clock,
    github,
    discovery,
    jobRunner: noopJobRunner(),
    intervalMs: DEFAULT_WATCH_INTERVAL_MS,
  };

  return {
    paths,
    db,
    repos,
    clock,
    git: gitRepo,
    repo,
    project,
    github,
    discovery,
    deps,
    tick(): Promise<WatchTickResult> {
      return runWatchTick(deps, project.projectId);
    },
    events() {
      return repos.changes.page(project.projectId, null, 1000).items;
    },
    jobs() {
      return repos.jobs.listByProject(project.projectId, [...ALL_JOB_STATES]);
    },
    discoveryCursor(kind = "default_branch") {
      const streamId =
        kind === "pull_request"
          ? PULL_REQUEST_DISCOVERY_STREAM
          : DEFAULT_BRANCH_STREAM;
      return repos.cursors.get(repo.repoId, streamId, "discovery");
    },
    close(): void {
      db.close();
      gitRepo.close();
    },
  };
}

/** The discovery options every test that calls the service directly uses. */
export function discoveryOptions(now: Date) {
  return {
    now,
    overlapMs: PR_OVERLAP_MS,
    perPage: DISCOVERY_DEFAULTS.perPage,
    maxPages: DISCOVERY_DEFAULTS.maxPages,
  };
}

/**
 * A real `JobRunner` with the pipeline seams stubbed out. Change jobs fail at
 * `requireModel` (model is null), which is exactly what the retry/cancel tests
 * need without touching snapshots or the publisher.
 */
export function createRealRunner(harness: UpdateHarness): {
  runner: ReturnType<typeof createJobRunner>;
} {
  const usage = {
    record(): void {},
    canSpend(): boolean {
      return true;
    },
    totals() {
      return { calls: 0, inputTokens: 0, outputTokens: 0, costCents: null };
    },
  };
  return {
    runner: createJobRunner({
      db: harness.db,
      repos: harness.repos,
      paths: harness.paths,
      clock: harness.clock,
      snapshotService: {} as never,
      publisher: {} as never,
      upstream: {} as never,
      lessons: {} as never,
      model: null,
      usage,
    }),
  };
}

/** The `EnqueueJobInput` shape used by the real-runner tests. */
export function manualChangeJob(
  harness: UpdateHarness,
  eventId: ReturnType<typeof changeEventIdFromKey>,
  streamId: string,
  headSha: string,
) {
  return {
    kind: "change_analysis" as const,
    repoId: harness.repo.repoId,
    projectId: harness.project.projectId,
    streamId,
    comparisonBaseSha: null,
    headSha,
    baseContextSha: null,
    scopeHash: harness.project.scope.hash,
    analysisConfigHash: "cfg",
    payload: {
      kind: "change" as const,
      eventId,
      baseSha: headSha,
      headSha,
      mergeBaseSha: headSha,
      streamKind: "default_branch" as const,
    },
  };
}

/** Removes a tree that read-only snapshot code may have touched. */
export function cleanupHarness(harness: UpdateHarness | undefined): void {
  if (harness === undefined) return;
  try {
    harness.close();
  } catch {
    // best effort
  }
}
