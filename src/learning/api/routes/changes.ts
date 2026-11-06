/**
 * Watch control and the change inbox (architecture §12.5, §12.6, §14.1,
 * §14.2, §3.8, AC-API-10, AC-UPD-01/03, AC-PRJ-13).
 *
 * Three routes share this module because they share one subject: what happened
 * to a followed project since the last look.
 *
 * - `PUT /api/projects/:id/watch` toggles the flag and, when `refreshNow` is
 *   set, runs **exactly one** scheduler tick (`runWatchTick`) and reports its
 *   `{discovered,enqueued,gaps}` counters. Local projects have no remote to
 *   poll and are refused with `watch_requires_github` (400); a refresh of a
 *   disabled watch is `409 conflict`. Manual refresh is a body field, not a
 *   route, so it does not add an endpoint to `router.ts`.
 * - `GET /api/projects/:id/changes` pages the inbox with an opaque keyset
 *   cursor (`ChangesRepo.page`). It never filters by `state` or
 *   `significance`: every stored event is reachable, because a paging bug that
 *   hides one is indistinguishable from never discovering it.
 * - `GET /api/projects/:id/changes/:changeId` returns one event with its
 *   payload, the six-field change lesson and a display-only commit reference
 *   (never a GitHub write/comment link).
 *
 * Every handler asserts the project is active first, so a removed project is
 * `410 source_removed` with `details.reason="project_removed"` on all three
 * routes and an unknown id is `404 not_found` (§5.8).
 */

import fs from "node:fs";
import path from "node:path";

import { LearningError, errorMessageFor } from "../../contracts/index.js";
import type {
  AppDeps,
  ChangeDetailView,
  ChangeEventId,
  ChangeLesson,
  ChangeListView,
  ChangeRecord,
  ChangeSummary,
  GenerationId,
  GenerationRecord,
  HandlerFactory,
  ProjectId,
  PutWatchRequest,
  PutWatchResponse,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
  WatchTickResult,
} from "../../contracts/index.js";
import { normalizeScope } from "../../projects/index.js";
import { generationKnowledgeDir, requireActiveProject } from "./projects.js";

export const routes: readonly RouteDef[] = [
  {
    method: "PUT",
    pattern: "/api/projects/:id/watch",
    auth: "session",
    handler: "watch.put",
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/changes",
    auth: "session",
    handler: "changes.list",
  },
  {
    method: "GET",
    pattern: "/api/projects/:id/changes/:changeId",
    auth: "session",
    handler: "changes.get",
  },
];

/** Page size when the query omits `limit` (the inbox page uses the same 20). */
const DEFAULT_LIMIT = 20;
/** A client cannot ask for an unbounded page; larger values are clamped. */
const MAX_LIMIT = 200;

function invalidInput(
  message: string,
  details: Record<string, unknown>,
): LearningError {
  return new LearningError("invalid_input", message, details);
}

function notFound(details: Record<string, unknown>): LearningError {
  return new LearningError(
    "not_found",
    errorMessageFor("not_found", "zh"),
    details,
  );
}

// ── record → view plumbing (also used by the static inbox page) ─────────────

/** A one-line human label; a PR carries its own title, gaps are named. */
export function changeTitle(change: ChangeRecord): string {
  const pr = change.payload.pr;
  if (pr !== undefined) return pr.title;
  if (change.kind === "history_gap") return "历史缺口";
  if (change.kind === "branch_switch") return "分支切换";
  if (change.kind === "baseline") return "基线";
  if (change.headSha !== null) return `提交 ${change.headSha.slice(0, 12)}`;
  return "变更记录";
}

export function toChangeSummary(change: ChangeRecord): ChangeSummary {
  return {
    changeId: change.eventId,
    kind: change.kind,
    streamKind: change.streamKind,
    state: change.state,
    significance: change.significance,
    headSha: change.headSha,
    baseSha: change.baseSha,
    hasGap:
      change.state === "gap" ||
      change.kind === "history_gap" ||
      change.gapReason !== null,
    linkedChangeId: change.linkedEventId,
    discoveredAt: change.discoveredAt,
    publishedAt: change.publishedAt,
    title: changeTitle(change),
  };
}

// ── watch ───────────────────────────────────────────────────────────────────

function watchRequiresGithub(projectId: ProjectId): LearningError {
  return new LearningError(
    "watch_requires_github",
    errorMessageFor("watch_requires_github", "zh"),
    { projectId },
  );
}

function disabledRefresh(projectId: ProjectId): LearningError {
  return new LearningError("conflict", "跟进未开启", {
    projectId,
    reason: "watch_disabled",
  });
}

function refreshedOf(tick: WatchTickResult | undefined): {
  discovered: number;
  enqueued: number;
  gaps: number;
} {
  return {
    discovered: tick?.discovered ?? 0,
    enqueued: tick?.enqueued ?? 0,
    gaps: tick?.gaps ?? 0,
  };
}

const putWatch: HandlerFactory = (deps) => async (req) => {
  const projectId = req.params.id as ProjectId;
  const project = requireActiveProject(deps, projectId);
  const body = req.body as PutWatchRequest;

  // A local project has no remote to poll; this holds for enable, disable and
  // refresh alike, so the check precedes every write (AC-PRJ-13).
  if (project.kind !== "github") {
    throw watchRequiresGithub(projectId);
  }

  if (!body.enabled) {
    // Refreshing a watch that is being disabled has no meaning; refuse it
    // before any state is written.
    if (body.refreshNow === true) throw disabledRefresh(projectId);
    deps.repos.projects.setWatch(
      projectId,
      false,
      body.scope === undefined ? null : normalizeScope(body.scope),
    );
    const response: PutWatchResponse = {
      watchEnabled: false,
      lastPollAt: deps.watch?.lastPollAt(projectId) ?? null,
      refreshed: null,
    };
    return { kind: "json", status: 200, body: response };
  }

  deps.repos.projects.setWatch(
    projectId,
    true,
    body.scope === undefined ? null : normalizeScope(body.scope),
  );

  // Manual refresh is exactly one tick, named to one project: never the
  // all-project variant (AC-UPD-03, §12.5).
  const tick =
    body.refreshNow === true
      ? (await deps.watch.runTick(projectId))[0]
      : undefined;

  const response: PutWatchResponse = {
    watchEnabled:
      deps.repos.projects.byId(projectId)?.watchEnabled ?? body.enabled,
    lastPollAt: tick?.lastPollAt ?? deps.watch?.lastPollAt(projectId) ?? null,
    refreshed: body.refreshNow === true ? refreshedOf(tick) : null,
  };
  return { kind: "json", status: 200, body: response };
};

// ── change lesson lookup ────────────────────────────────────────────────────

function safeJoin(root: string, relPath: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, relPath);
  if (full !== base && !full.startsWith(`${base}${path.sep}`)) return null;
  return full;
}

/**
 * The change generation is reached through the job the event enqueued:
 * `change_events.job_id` → `jobs.output_generation_id`. The generation row
 * carries the same `job_id`, so it is also a fallback when the job row is not
 * retained; a published `change` generation for the same head commit is the
 * last resort. A lesson file that is missing or unreadable degrades to
 * `lesson: null`; the event itself is still served.
 */
function generationForEvent(
  deps: AppDeps,
  event: ChangeRecord,
): GenerationRecord | null {
  if (event.jobId !== null) {
    const job = deps.repos.jobs.byId(event.jobId);
    if (job !== null && job.outputGenerationId !== null) {
      const generation = deps.repos.generations.byId(job.outputGenerationId);
      if (generation !== null) return generation;
    }
    const byJob = deps.db.raw
      .prepare(
        `SELECT generation_id FROM generations
         WHERE job_id = ? AND kind = 'change' LIMIT 1`,
      )
      .get(event.jobId) as { generation_id: string } | undefined;
    if (byJob !== undefined) {
      const generation = deps.repos.generations.byId(
        byJob.generation_id as GenerationId,
      );
      if (generation !== null) return generation;
    }
  }
  if (event.headSha === null) return null;
  const byCommit = deps.db.raw
    .prepare(
      `SELECT generation_id FROM generations
       WHERE repo_id = ? AND commit_sha = ? AND kind = 'change'
         AND status = 'published'
       ORDER BY published_at DESC LIMIT 1`,
    )
    .get(event.repoId, event.headSha) as { generation_id: string } | undefined;
  return byCommit === undefined
    ? null
    : deps.repos.generations.byId(byCommit.generation_id as GenerationId);
}

function readChangeLesson(
  deps: AppDeps,
  generation: GenerationRecord,
): ChangeLesson | null {
  const root = generationKnowledgeDir(deps, generation.contentDir);
  for (const row of deps.repos.lessons.listByGeneration(
    generation.generationId,
  )) {
    if (row.kind !== "change") continue;
    const file = safeJoin(root, row.relPath);
    if (file === null) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { kind?: unknown }).kind === "change"
      ) {
        return raw as ChangeLesson;
      }
    } catch {
      // A malformed file must not turn the read into a 500; try the next row.
    }
  }
  return null;
}

/**
 * Resolves the lesson for an event, following one merge-link hop. When a PR
 * and its default-branch event share content, only one of them carries a
 * lesson; the link makes the other one readable too.
 */
function lessonForEvent(
  deps: AppDeps,
  event: ChangeRecord,
  seen: Set<string>,
): ChangeLesson | null {
  const generation = generationForEvent(deps, event);
  if (generation !== null) {
    const lesson = readChangeLesson(deps, generation);
    if (lesson !== null) return lesson;
  }
  const linked = event.linkedEventId;
  if (linked === null || seen.has(linked)) return null;
  seen.add(linked);
  const other = deps.repos.changes.byId(linked);
  return other === null ? null : lessonForEvent(deps, other, seen);
}

/** Display-only: a short record of the commit, never a GitHub URL. */
function commitRefOf(event: ChangeRecord): ChangeDetailView["commitRef"] {
  if (event.headSha === null) return null;
  return { sha: event.headSha, label: `提交 ${event.headSha.slice(0, 12)}` };
}

// ── list / detail ───────────────────────────────────────────────────────────

/**
 * `limit` is a non-negative integer string (validate.ts). `0` is refused — an
 * empty page with a non-null cursor would be a silent omission — and a large
 * value is clamped so one request cannot materialise the whole inbox.
 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidInput("limit 必须是正整数", { field: "limit" });
  }
  return Math.min(parsed, MAX_LIMIT);
}

/** An empty cursor is the first page; anything else is validated by the repo. */
function parseCursor(raw: string | undefined): string | null {
  return raw === undefined || raw === "" ? null : raw;
}

const listChanges: HandlerFactory = (deps) => (req) => {
  const projectId = req.params.id as ProjectId;
  requireActiveProject(deps, projectId);

  const page = deps.repos.changes.page(
    projectId,
    parseCursor(req.query.cursor),
    parseLimit(req.query.limit),
  );
  const body: ChangeListView = {
    items: page.items.map(toChangeSummary),
    next: page.next,
  };
  return Promise.resolve({ kind: "json", status: 200, body });
};

const getChange: HandlerFactory = (deps) => (req) => {
  const projectId = req.params.id as ProjectId;
  requireActiveProject(deps, projectId);

  const changeId = req.params.changeId as ChangeEventId;
  const event = deps.repos.changes.byId(changeId);
  // A change id that belongs to another project is indistinguishable from an
  // unknown one: never leak the existence of a foreign inbox row.
  if (event === null || event.projectId !== projectId) {
    throw notFound({ projectId, changeId });
  }

  const body: ChangeDetailView = {
    change: toChangeSummary(event),
    payload: event.payload,
    lesson: lessonForEvent(deps, event, new Set<string>()),
    commitRef: commitRefOf(event),
  };
  return Promise.resolve({ kind: "json", status: 200, body });
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "watch.put": putWatch,
  "changes.list": listChanges,
  "changes.get": getChange,
};

export const changesModule: RouteModule = {
  id: "changes",
  routes,
  handlers,
};

/** The name named by the issue contract; same `RouteModule` object. */
export const changesRoutes: RouteModule = changesModule;
