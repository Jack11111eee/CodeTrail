/* eslint-disable @typescript-eslint/require-await -- the discovery transaction is synchronous by design */
/**
 * Transactional discovery of the default branch and pull requests
 * (architecture §12.2, §12.3).
 *
 * The failure mode this module exists to prevent is silent event loss: one
 * skipped page, one unpersisted first-parent node or one cursor advance that
 * runs ahead of its events destroys the inbox. Every advance is therefore a
 * compare-and-swap inside the same transaction that inserts the events and
 * their job rows.
 */

import {
  changeEventIdFromKey,
  computeConfigHash,
  computeDedupeKey,
  computeEventKey,
  computeScopeHash,
  emptyCursor,
  jobIdFromDedupeKey,
  LearningError,
  toPullRequestPayload,
  windowStart,
} from "../contracts/index.js";
import type {
  ChangeRecord,
  Clock,
  CursorJson,
  CursorUpdate,
  Database,
  DataPaths,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveryService,
  EnqueueJobInput,
  GenerationConfig,
  GithubClient,
  JobId,
  NewChangeEvent,
  ProjectId,
  ProjectRecord,
  RepoRecord,
  Repositories,
  Significance,
  StreamKind,
} from "../contracts/index.js";
import {
  LESSON_PIPELINE_VERSION,
  MAX_FILES,
  MAX_LOOKBACK_MS,
  PR_OVERLAP_MS,
  PROMPT_TEMPLATE_VERSION,
} from "../config/defaults.js";
import { mirrorPath } from "../config/paths.js";
import {
  git,
  normalizeGithubUrl,
  parseIdentity,
  resolveRef,
  type MirrorHandle,
} from "../projects/index.js";
import { classifySignificance } from "./change-lesson.js";
import { diffBetween, readFileAt } from "./diff.js";

// Declared in contracts/github.ts (§3.16); re-export only.
export type { DiscoveryOptions, DiscoveryResult, DiscoveryService };

/** The stable default-branch stream used by both the cursor and its events. */
export const DEFAULT_BRANCH_STREAM = "default_branch";
/** The PR *discovery* cursor stream (one watermark for the whole list). */
export const PULL_REQUEST_DISCOVERY_STREAM = "pull_request";

/** Per-PR event stream, so one stalled PR cannot block every other PR. */
export function pullRequestStreamId(number: number): string {
  return `${PULL_REQUEST_DISCOVERY_STREAM}:${number}`;
}

export interface DiscoveryCommit {
  events: NewChangeEvent[];
  jobs: EnqueueJobInput[];
  discoveryCursor: CursorUpdate;
}

export interface DiscoveryDeps {
  db: Database;
  repos: Repositories;
  clock: Clock;
  github: GithubClient;
  paths: DataPaths;
}

function defaultAnalysisConfig(repos: Repositories): GenerationConfig {
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

function resolveProject(
  deps: Pick<DiscoveryDeps, "repos" | "paths">,
  projectId: ProjectId,
): { project: ProjectRecord; repo: RepoRecord; mirror: MirrorHandle } {
  const project = deps.repos.projects.byId(projectId);
  if (project === null || project.deletedAt !== null) {
    throw new LearningError("not_found", "项目不存在", { projectId });
  }
  const repo = deps.repos.repos.byId(project.repoId);
  if (repo === null) {
    throw new LearningError("not_found", "仓库不存在", {
      projectId,
      repoId: project.repoId,
    });
  }
  return {
    project,
    repo,
    mirror: {
      repoId: repo.repoId,
      path: repo.mirrorPath || mirrorPath(deps.paths, repo.repoId),
      identity: repo.identity,
    },
  };
}

function ownerRepoOf(repo: RepoRecord): string {
  const parsed = parseIdentity(repo.identity);
  if (parsed.kind === "github") return parsed.value;
  if (repo.remoteUrl !== null) {
    const github = normalizeGithubUrl(repo.remoteUrl);
    return `${github.owner}/${github.repo}`;
  }
  throw new LearningError(
    "watch_requires_github",
    "只有 GitHub 项目可以开启跟进",
    { repoId: repo.repoId },
  );
}

function assertGithubProject(project: ProjectRecord): void {
  if (project.kind !== "github") {
    throw new LearningError(
      "watch_requires_github",
      "只有 GitHub 项目可以开启跟进",
      { projectId: project.projectId },
    );
  }
}

function scopeHashOf(project: ProjectRecord): string {
  return project.scope.hash || computeScopeHash(project.scope);
}

function cursorUpdate(
  repoId: RepoRecord["repoId"],
  streamId: string,
  kind: CursorUpdate["kind"],
  cursor: CursorJson,
  previous: CursorJson | null,
): CursorUpdate {
  return {
    repoId,
    streamId,
    kind,
    cursor,
    expectedPrevious:
      previous === null
        ? null
        : { headSha: previous.headSha, updatedAt: previous.updatedAt },
  };
}

/** Inserts a job row unless its dedupe key already exists. */
export function insertJobRow(
  repos: Repositories,
  input: EnqueueJobInput,
  createdAt: string,
): { jobId: JobId; created: boolean } {
  const dedupeKey = computeDedupeKey(input);
  const existing = repos.jobs.byDedupeKey(dedupeKey);
  if (existing !== null) {
    return { jobId: existing.jobId, created: false };
  }
  const jobId = jobIdFromDedupeKey(dedupeKey);
  repos.jobs.insert({
    jobId,
    dedupeKey,
    kind: input.kind,
    repoId: input.repoId,
    projectId: input.projectId,
    streamId: input.streamId,
    state: "queued",
    payload: input.payload,
    attempt: 0,
    errorCode: null,
    errorDetail: null,
    progress: null,
    outputGenerationId: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  });
  return { jobId, created: true };
}

/**
 * Drops events whose stable identity is already persisted (or repeated inside
 * the batch). Re-baselining a head that already has a baseline — a branch
 * rename with no new commit, or a force-push back to a previously seen head —
 * recomputes the same `event_key`; a plain insert would violate
 * `UNIQUE(event_key)`, roll the whole discovery transaction back and stall the
 * cursor forever (AC-UPD-14/15).
 */
function pendingEvents(
  repos: Repositories,
  events: NewChangeEvent[],
): NewChangeEvent[] {
  const seen = new Set<string>();
  const pending: NewChangeEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    if (repos.changes.byId(event.eventId) !== null) continue;
    pending.push(event);
  }
  return pending;
}

/**
 * Writes events + pending jobs + the discovery cursor in **one** transaction
 * (§12.3). Model analysis happens only after this returns; a failed
 * compare-and-swap rolls back everything, so the cursor can never advance past
 * events that were not persisted.
 */
export async function commitDiscovery(
  deps: Pick<DiscoveryDeps, "db" | "repos" | "clock">,
  commit: DiscoveryCommit,
): Promise<void> {
  const at = deps.clock.now().toISOString();
  deps.db.transaction(() => {
    const events = pendingEvents(deps.repos, commit.events);
    if (events.length > 0) {
      deps.repos.changes.insertMany(events);
    }
    for (const input of commit.jobs) {
      insertJobRow(deps.repos, input, at);
    }
    const advanced = deps.repos.cursors.put(commit.discoveryCursor);
    if (!advanced) {
      throw new LearningError("conflict", "发现游标已被推进", {
        streamId: commit.discoveryCursor.streamId,
      });
    }
  });
}

/** Streams with an unfinished prior event or a running job. */
function blockedStreams(
  repos: Repositories,
  streamIds: readonly string[],
): Set<string> {
  const blocked = new Set<string>();
  for (const streamId of streamIds) {
    const jobs = repos.jobs.listByStream(streamId);
    const running = jobs.some(
      (job) => job.state === "running" || job.state === "cancelling",
    );
    const unfinished = repos.changes.listByStream(streamId, [
      "waiting",
      "failed",
      "cancelled",
    ]);
    if (running || unfinished.length > 0) blocked.add(streamId);
  }
  return blocked;
}

/**
 * Reconciles event states with their jobs. A failed/cancelled job keeps its
 * event (never deleted) and makes every later event in the same stream
 * `waiting`; a later stream continues untouched (AC-UPD-16/20).
 */
export function reconcileEventStates(
  repos: Repositories,
  projectId: ProjectId,
): void {
  const jobs = repos.jobs.listByProject(projectId, [
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]);
  const streams = new Set<string>();
  for (const job of jobs) {
    if (job.streamId !== null) streams.add(job.streamId);
  }
  for (const streamId of streams) {
    const events = repos.changes.listByStream(streamId, [
      "discovered",
      "queued",
      "analyzing",
      "waiting",
      "failed",
      "cancelled",
    ]);
    let blocked = false;
    for (const event of events) {
      const job = event.jobId === null ? null : repos.jobs.byId(event.jobId);
      if (job?.state === "failed") {
        if (event.state !== "failed") {
          repos.changes.setState(event.eventId, "failed");
        }
        blocked = true;
        continue;
      }
      if (job?.state === "cancelled") {
        if (event.state !== "cancelled") {
          repos.changes.setState(event.eventId, "cancelled");
        }
        blocked = true;
        continue;
      }
      if (blocked) {
        if (event.state !== "waiting") {
          repos.changes.setState(event.eventId, "waiting");
        }
        continue;
      }
      if (job?.state === "completed" || event.publishedAt !== null) {
        blocked = false;
      }
    }
  }
}

async function parentsOf(
  mirror: MirrorHandle,
  sha: string,
): Promise<string[] | null> {
  const result = await git(mirror.path, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    sha,
  ]);
  if (result.code !== 0) return null;
  const fields = result.stdout
    .trim()
    .split(/\s+/u)
    .filter((f) => f !== "");
  if (fields.length === 0) return null;
  return fields.slice(1);
}

/** Commits reachable only through the second (or later) parent of a merge. */
async function associatedCommits(
  mirror: MirrorHandle,
  parents: readonly string[],
): Promise<string[]> {
  if (parents.length <= 1) return [];
  const first = parents[0];
  const found = new Set<string>();
  for (const parent of parents.slice(1)) {
    const result = await git(mirror.path, ["rev-list", parent, "--not", first]);
    if (result.code !== 0) continue;
    for (const sha of result.stdout.trim().split(/\s+/u)) {
      if (sha !== "") found.add(sha);
    }
  }
  return [...found];
}

/**
 * The first-parent chain from `oldHead` (exclusive) to `newHead` (inclusive).
 * Returns null when `oldHead` is not an ancestor of `newHead` or is not on the
 * first-parent chain — the force-push / history-gap case (AC-UPD-14).
 */
async function firstParentChain(
  mirror: MirrorHandle,
  oldHead: string,
  newHead: string,
): Promise<Array<{ sha: string; parents: string[] }> | null> {
  if (oldHead === newHead) return [];
  const ancestry = await git(mirror.path, [
    "merge-base",
    "--is-ancestor",
    oldHead,
    newHead,
  ]);
  if (ancestry.code !== 0) return null;

  const chain: Array<{ sha: string; parents: string[] }> = [];
  let current = newHead;
  let guard = 0;
  while (current !== oldHead) {
    if (guard > 200_000) return null;
    guard += 1;
    const parents = await parentsOf(mirror, current);
    if (parents === null || parents.length === 0) return null;
    chain.push({ sha: current, parents });
    current = parents[0];
  }
  return chain.reverse();
}

async function significanceFor(
  mirror: MirrorHandle,
  baseSha: string | null,
  headSha: string,
): Promise<Significance> {
  if (baseSha === null) return "full";
  const diff = await diffBetween(mirror, baseSha, headSha, {
    maxFiles: MAX_FILES,
  });
  if (diff.gaps.length > 0) return "full";
  return classifySignificance(diff.entries, {
    readBase: (path) => readFileAt(mirror, baseSha, path),
    readHead: (path) => readFileAt(mirror, headSha, path),
  });
}

/** Builds the `EnqueueJobInput` for a change event. */
function changeJobInput(i: {
  event: Pick<
    ChangeRecord,
    | "eventId"
    | "repoId"
    | "projectId"
    | "streamId"
    | "baseSha"
    | "headSha"
    | "mergeBaseSha"
    | "baseContextSha"
  >;
  streamKind: StreamKind;
  scopeHash: string;
  analysisConfigHash: string;
}): EnqueueJobInput {
  const headSha = i.event.headSha as string;
  const baseSha = i.event.baseSha ?? i.event.mergeBaseSha ?? headSha;
  return {
    kind: "change_analysis",
    repoId: i.event.repoId,
    projectId: i.event.projectId,
    streamId: i.event.streamId,
    comparisonBaseSha: null,
    headSha,
    baseContextSha: i.event.baseContextSha,
    scopeHash: i.scopeHash,
    analysisConfigHash: i.analysisConfigHash,
    payload: {
      kind: "change",
      eventId: i.event.eventId,
      baseSha,
      headSha,
      mergeBaseSha: i.event.mergeBaseSha ?? baseSha,
      streamKind: i.streamKind,
    },
  };
}

function baseEvent(i: {
  eventKey: string;
  repo: RepoRecord;
  project: ProjectRecord;
  streamId: string;
  streamKind: StreamKind;
  kind: NewChangeEvent["kind"];
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  baseContextSha: string | null;
  significance: Significance;
  state: NewChangeEvent["state"];
  gapReason: string | null;
  jobId: JobId | null;
  discoveredAt: string;
  payload: NewChangeEvent["payload"];
}): NewChangeEvent {
  return {
    eventId: changeEventIdFromKey(i.eventKey),
    eventKey: i.eventKey,
    repoId: i.repo.repoId,
    projectId: i.project.projectId,
    streamId: i.streamId,
    streamKind: i.streamKind,
    kind: i.kind,
    baseSha: i.baseSha,
    headSha: i.headSha,
    mergeBaseSha: i.mergeBaseSha,
    baseContextSha: i.baseContextSha,
    significance: i.significance,
    state: i.state,
    jobId: i.jobId,
    gapReason: i.gapReason,
    linkedEventId: null,
    linkRelation: null,
    discoveredAt: i.discoveredAt,
    publishedAt: null,
    payload: i.payload,
  };
}

/** Implements `DiscoveryService` (§3.16). */
export function createDiscoveryService(deps: DiscoveryDeps): DiscoveryService {
  const { repos, github } = deps;

  async function observedHead(
    mirror: MirrorHandle,
    ownerRepo: string,
    branch: string,
    cursor: CursorJson,
  ): Promise<string | null> {
    const since = cursor.lastPollAt ?? new Date(0).toISOString();
    try {
      const page = await github.commitsSince(ownerRepo, branch, since, {
        page: 1,
        perPage: 1,
      });
      const sha = page.items[0]?.sha;
      if (typeof sha === "string" && sha !== "") return sha;
    } catch {
      // Fall back to the local ref below; a missing remote must not fabricate
      // a head.
    }
    try {
      return await resolveRef(mirror, branch);
    } catch {
      return null;
    }
  }

  function makeJob(
    event: NewChangeEvent,
    streamKind: StreamKind,
    scopeHash: string,
    analysisConfigHash: string,
  ): EnqueueJobInput {
    const input = changeJobInput({
      event,
      streamKind,
      scopeHash,
      analysisConfigHash,
    });
    event.jobId = jobIdFromDedupeKey(computeDedupeKey(input));
    return input;
  }

  async function tickDefaultBranch(
    projectId: ProjectId,
    opts: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    const { project, repo, mirror } = resolveProject(deps, projectId);
    assertGithubProject(project);
    const ownerRepo = ownerRepoOf(repo);
    const at = opts.now.toISOString();
    const previous = repos.cursors.get(
      repo.repoId,
      DEFAULT_BRANCH_STREAM,
      "discovery",
    );
    const cursor = previous ?? emptyCursor("default_branch");

    const branch = await github.defaultBranch(ownerRepo);
    const head = await observedHead(mirror, ownerRepo, branch, cursor);

    const events: NewChangeEvent[] = [];
    const jobs: EnqueueJobInput[] = [];
    let gaps = 0;
    let branchSwitch = false;
    let discovered = 0;

    const scopeHash = scopeHashOf(project);
    const configHash = computeConfigHash(defaultAnalysisConfig(repos));

    if (head !== null) {
      const addBaseline = (): void => {
        const eventKey = computeEventKey({
          repoId: repo.repoId,
          streamId: DEFAULT_BRANCH_STREAM,
          kind: "baseline",
          baseSha: null,
          headSha: head,
          mergeBaseSha: null,
          baseContextSha: null,
        });
        const eventId = changeEventIdFromKey(eventKey);
        // A head can already carry a baseline: a rename without a new commit,
        // or a force-push back to a previously baselined head. The event is
        // already persisted, so a second insert would abort discovery.
        if (
          repos.changes.byId(eventId) !== null ||
          events.some((event) => event.eventId === eventId)
        ) {
          return;
        }
        events.push(
          baseEvent({
            eventKey,
            repo,
            project,
            streamId: DEFAULT_BRANCH_STREAM,
            streamKind: "default_branch",
            kind: "baseline",
            baseSha: null,
            headSha: head,
            mergeBaseSha: null,
            baseContextSha: null,
            significance: "full",
            state: "discovered",
            gapReason: null,
            jobId: null,
            discoveredAt: at,
            payload: {},
          }),
        );
        discovered += 1;
      };

      if (previous === null) {
        // First enable: baseline at the current head, replay nothing (AC-UPD-02).
        addBaseline();
      } else if (cursor.branch !== null && cursor.branch !== branch) {
        branchSwitch = true;
        const eventKey = computeEventKey({
          repoId: repo.repoId,
          streamId: DEFAULT_BRANCH_STREAM,
          kind: "branch_switch",
          baseSha: cursor.headSha,
          headSha: head,
          mergeBaseSha: null,
          baseContextSha: null,
        });
        events.push(
          baseEvent({
            eventKey,
            repo,
            project,
            streamId: DEFAULT_BRANCH_STREAM,
            streamKind: "default_branch",
            kind: "branch_switch",
            baseSha: cursor.headSha,
            headSha: head,
            mergeBaseSha: null,
            baseContextSha: null,
            significance: "full",
            state: "gap",
            gapReason: "branch_switch",
            jobId: null,
            discoveredAt: at,
            payload: {
              gapReason: "branch_switch",
              fromBranch: cursor.branch,
              toBranch: branch,
            },
          }),
        );
        discovered += 1;
        addBaseline();
      } else if (cursor.headSha === null) {
        addBaseline();
      } else if (cursor.headSha !== head) {
        const chain = await firstParentChain(mirror, cursor.headSha, head);
        if (chain === null) {
          gaps += 1;
          const gapKey = computeEventKey({
            repoId: repo.repoId,
            streamId: DEFAULT_BRANCH_STREAM,
            kind: "history_gap",
            baseSha: cursor.headSha,
            headSha: head,
            mergeBaseSha: null,
            baseContextSha: null,
          });
          events.push(
            baseEvent({
              eventKey: gapKey,
              repo,
              project,
              streamId: DEFAULT_BRANCH_STREAM,
              streamKind: "default_branch",
              kind: "history_gap",
              baseSha: cursor.headSha,
              headSha: head,
              mergeBaseSha: null,
              baseContextSha: null,
              significance: "full",
              state: "gap",
              gapReason: "history_gap",
              jobId: null,
              discoveredAt: at,
              payload: {
                gapReason: "history_gap",
                comparison: { baseSha: cursor.headSha, headSha: head },
              },
            }),
          );
          discovered += 1;
          addBaseline();
        } else {
          const blocked = blockedStreams(repos, [DEFAULT_BRANCH_STREAM]);
          for (const node of chain) {
            const firstParent = node.parents[0] ?? null;
            const associated = await associatedCommits(mirror, node.parents);
            const kind = node.parents.length > 1 ? "merge_commit" : "commit";
            const significance = await significanceFor(
              mirror,
              firstParent,
              node.sha,
            );
            const eventKey = computeEventKey({
              repoId: repo.repoId,
              streamId: DEFAULT_BRANCH_STREAM,
              kind,
              baseSha: firstParent,
              headSha: node.sha,
              mergeBaseSha: firstParent,
              baseContextSha: firstParent,
            });
            const event = baseEvent({
              eventKey,
              repo,
              project,
              streamId: DEFAULT_BRANCH_STREAM,
              streamKind: "default_branch",
              kind,
              baseSha: firstParent,
              headSha: node.sha,
              mergeBaseSha: firstParent,
              baseContextSha: firstParent,
              significance,
              state: blocked.has(DEFAULT_BRANCH_STREAM) ? "waiting" : "queued",
              gapReason: null,
              jobId: null,
              discoveredAt: at,
              payload: {
                commit: { firstParent, associatedCommits: associated },
              },
            });
            if (firstParent === null) {
              event.state = "discovered";
            } else if (!blocked.has(DEFAULT_BRANCH_STREAM)) {
              jobs.push(
                makeJob(event, "default_branch", scopeHash, configHash),
              );
            }
            events.push(event);
            discovered += 1;
          }
        }
      }
    }

    const nextCursor: CursorJson = {
      ...cursor,
      headSha: head ?? cursor.headSha,
      branch,
      lastGapSha: gaps > 0 ? cursor.headSha : cursor.lastGapSha,
      lastGapAt: gaps > 0 ? at : cursor.lastGapAt,
      lastPollAt: at,
    };
    await commitDiscovery(deps, {
      events,
      jobs,
      discoveryCursor: cursorUpdate(
        repo.repoId,
        DEFAULT_BRANCH_STREAM,
        "discovery",
        nextCursor,
        previous,
      ),
    });

    return {
      discovered,
      enqueued: jobs.length,
      gaps,
      branchSwitch,
      nextDiscoveryCursor: nextCursor,
    };
  }

  async function mergeBaseOf(
    mirror: MirrorHandle,
    baseHeadSha: string,
    headSha: string,
  ): Promise<string> {
    const result = await git(mirror.path, ["merge-base", baseHeadSha, headSha]);
    const sha = result.stdout.trim();
    if (result.code === 0 && /^[0-9a-f]{40}$/u.test(sha)) return sha;
    return baseHeadSha;
  }

  async function tickPullRequests(
    projectId: ProjectId,
    opts: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    const { project, repo, mirror } = resolveProject(deps, projectId);
    assertGithubProject(project);
    const ownerRepo = ownerRepoOf(repo);
    const at = opts.now.toISOString();
    const stored = repos.cursors.get(
      repo.repoId,
      PULL_REQUEST_DISCOVERY_STREAM,
      "discovery",
    );
    let expectedPrevious: CursorJson | null = stored;
    let cursor = stored ?? emptyCursor("pull_request");
    const overlapMs = Number.isFinite(opts.overlapMs)
      ? opts.overlapMs
      : PR_OVERLAP_MS;
    const start = windowStart(cursor, opts.now, MAX_LOOKBACK_MS, overlapMs);

    const scopeHash = scopeHashOf(project);
    const configHash = computeConfigHash(defaultAnalysisConfig(repos));

    let discovered = 0;
    let enqueued = 0;
    let gaps = 0;
    let page = cursor.page ?? 1;
    let closed = false;
    // `maxPages` is a per-tick budget, not an absolute page ceiling: an open
    // window whose page already exceeds it must still make progress on the
    // next tick, otherwise the PR stream stalls forever.
    let pagesThisTick = 0;

    while (!closed && pagesThisTick < opts.maxPages) {
      pagesThisTick += 1;
      const pageResult = await github.pullRequests(ownerRepo, {
        state: "all",
        sort: "updated",
        direction: "desc",
        page,
        perPage: opts.perPage,
      });

      const events: NewChangeEvent[] = [];
      const jobs: EnqueueJobInput[] = [];
      let windowDone = pageResult.items.length === 0;

      for (const item of pageResult.items) {
        const updated = Date.parse(item.updatedAt);
        if (Number.isFinite(updated) && updated < start.getTime()) {
          // Sorted by updated desc: everything after is outside the window.
          windowDone = true;
          break;
        }
        discovered += 1;

        const mergeBaseSha = await mergeBaseOf(
          mirror,
          item.baseHeadSha,
          item.headSha,
        );
        const prPayload = toPullRequestPayload(item, mergeBaseSha);
        const streamId = pullRequestStreamId(item.number);
        const eventKey = computeEventKey({
          repoId: repo.repoId,
          streamId,
          kind: "pull_request",
          baseSha: mergeBaseSha,
          headSha: item.headSha,
          mergeBaseSha,
          baseContextSha: item.baseHeadSha,
        });
        const eventId = changeEventIdFromKey(eventKey);
        const existing = repos.changes.byId(eventId);
        if (existing !== null) {
          // Metadata-only changes update the stored payload; no new job and no
          // rebuilt generation (AC-UPD-09).
          repos.changes.setState(existing.eventId, existing.state, {
            payload: { ...existing.payload, pr: prPayload },
          });
          continue;
        }

        const diff = await diffBetween(mirror, mergeBaseSha, item.headSha, {
          maxFiles: MAX_FILES,
        });
        if (diff.gaps.length > 0) gaps += 1;
        const significance =
          diff.gaps.length > 0
            ? "full"
            : await classifySignificance(diff.entries, {
                readBase: (path) => readFileAt(mirror, mergeBaseSha, path),
                readHead: (path) => readFileAt(mirror, item.headSha, path),
              });

        const blocked = blockedStreams(repos, [streamId]);
        const event = baseEvent({
          eventKey,
          repo,
          project,
          streamId,
          streamKind: "pull_request",
          kind: "pull_request",
          baseSha: mergeBaseSha,
          headSha: item.headSha,
          mergeBaseSha,
          baseContextSha: item.baseHeadSha,
          significance,
          state: blocked.has(streamId) ? "waiting" : "queued",
          gapReason: null,
          jobId: null,
          discoveredAt: at,
          payload: { pr: prPayload },
        });
        if (!blocked.has(streamId)) {
          jobs.push(makeJob(event, "pull_request", scopeHash, configHash));
        }
        events.push(event);
      }

      const shortPage = pageResult.items.length < opts.perPage;
      closed = windowDone || shortPage || pageResult.nextPage === null;
      const nextCursor: CursorJson = {
        ...cursor,
        page: closed ? null : page + 1,
        updatedAt: closed ? at : cursor.updatedAt,
        lastPollAt: at,
      };
      await commitDiscovery(deps, {
        events,
        jobs,
        discoveryCursor: cursorUpdate(
          repo.repoId,
          PULL_REQUEST_DISCOVERY_STREAM,
          "discovery",
          nextCursor,
          expectedPrevious,
        ),
      });
      enqueued += jobs.length;
      cursor = nextCursor;
      expectedPrevious = nextCursor;
      page += 1;
    }

    return {
      discovered,
      enqueued,
      gaps,
      branchSwitch: false,
      nextDiscoveryCursor: cursor,
    };
  }

  return { tickDefaultBranch, tickPullRequests };
}
