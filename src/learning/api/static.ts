/**
 * The static-UI seam (architecture §14.1, §15).
 *
 * `UI_ROUTES` is declared separately from the 32 `/api/*` routes so the API
 * comparison stays exact. Every page is rendered from the repositories here —
 * the renderers themselves never fetch — and the only writable surface is the
 * browser assets under `/assets/*`.
 *
 * The seam returns HTML as a `json` response with a `text/html` content type;
 * `api/server.ts` recognises that combination and routes it through `sendHtml`,
 * which owns the strict CSP. CSS/JS assets use the same string-body path with
 * their own content type.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toUsageView, computeStorageReport } from "./routes/ops.js";
import { toModelSettingsView } from "./routes/settings.js";
import type {
  AppDeps,
  ChangeRecord,
  ChangeSummary,
  ConversationView,
  CoverageReport,
  GenerationId,
  GenerationRecord,
  LessonDetailView,
  LessonRow,
  LessonSummary,
  MessageRecord,
  ProjectId,
  ProjectRecord,
  ProjectSummary,
  RouteRequest,
  RouteResponse,
  SettingsPageModel,
  StaticUiSeam,
} from "../contracts/index.js";
import type { JobState } from "../contracts/index.js";
import { toRenderData } from "../lessons/index.js";
import type { AnyLesson } from "../lessons/index.js";
import { renderInboxPage } from "../ui/pages/inbox.js";
import { POLLING_NOTE } from "../ui/pages/layout.js";
import { renderProjectsPage } from "../ui/pages/projects.js";
import { renderReaderPage } from "../ui/pages/reader.js";
import { renderSettingsPage } from "../ui/pages/settings.js";
import { renderTermsPage } from "../ui/pages/terms.js";

/** The UI routes, declared apart from `ROUTES` (architecture §14.1). */
export const UI_ROUTES: readonly { method: "GET"; pattern: string }[] =
  Object.freeze([
    { method: "GET", pattern: "/" },
    { method: "GET", pattern: "/learn" },
    { method: "GET", pattern: "/learn/reader" },
    { method: "GET", pattern: "/inbox" },
    { method: "GET", pattern: "/terms" },
    { method: "GET", pattern: "/settings" },
    { method: "GET", pattern: "/assets/*" },
  ]);

const ALL_JOB_STATES: readonly JobState[] = Object.freeze([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const HTML_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
});

const ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "styles.css": "text/css; charset=utf-8",
  "client.js": "text/javascript; charset=utf-8",
});

export interface StaticUiOptions {
  /** Directory holding `styles.css` and the compiled `client.js`. */
  assetDir?: string;
  /** Same-origin prefix; defaults to `/assets`. */
  assetBase?: string;
}

function defaultAssetDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
}

function htmlResponse(html: string): RouteResponse {
  return {
    kind: "json",
    status: 200,
    body: html,
    headers: { ...HTML_HEADERS },
  };
}

function serveAsset(assetDir: string, assetName: string): RouteResponse | null {
  // One flat segment only: no traversal, no nested directory, no hidden file.
  if (
    assetName === "" ||
    assetName.includes("/") ||
    assetName.includes("\\") ||
    assetName.startsWith(".") ||
    assetName.includes("..")
  ) {
    return null;
  }
  const type = ASSET_TYPES[assetName];
  if (type === undefined) return null;
  const file = path.join(assetDir, assetName);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, "utf8");
  return {
    kind: "json",
    status: 200,
    body: content,
    headers: { "Content-Type": type },
  };
}

// ── projects ────────────────────────────────────────────────────────────────

function latestJobState(deps: AppDeps, projectId: ProjectId): JobState | null {
  const jobs = deps.repos.jobs.listByProject(projectId, [...ALL_JOB_STATES]);
  const latest = jobs[jobs.length - 1];
  return latest === undefined ? null : latest.state;
}

function toProjectSummary(
  deps: AppDeps,
  project: ProjectRecord,
): ProjectSummary {
  const generation = deps.repos.generations.latestPublished(project.repoId, {
    kind: "research",
  });
  return {
    projectId: project.projectId,
    repoId: project.repoId,
    kind: project.kind,
    displayName: project.displayName,
    defaultBranch: project.defaultBranch,
    analyzedCommitSha: generation?.commitSha ?? null,
    lastSuccessAt: generation?.publishedAt ?? null,
    latestJobState: latestJobState(deps, project.projectId),
    watchEnabled: project.watchEnabled,
  };
}

function buildProjectsModel(deps: AppDeps) {
  return {
    projects: deps.repos.projects
      .list()
      .map((project) => toProjectSummary(deps, project)),
    modelConfigured: deps.repos.settings.model() !== null,
    pollingNote: POLLING_NOTE,
  };
}

// ── reader ──────────────────────────────────────────────────────────────────

function emptyCoverage(
  generationId: GenerationId,
  commitSha: string,
): CoverageReport {
  return {
    generationId,
    commitSha,
    complete: true,
    analyzed: [],
    gaps: [],
    counts: { totalFiles: 0, analyzedFiles: 0, excludedFiles: 0 },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

function resolveGeneration(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
): GenerationRecord | null {
  const requested = query.generation;
  if (requested !== undefined && requested !== "") {
    return deps.repos.generations.byId(requested as GenerationId);
  }
  const requestedProject = query.project;
  if (requestedProject !== undefined && requestedProject !== "") {
    const project = deps.repos.projects.byId(requestedProject as ProjectId);
    if (project !== null) {
      return deps.repos.generations.latestPublished(project.repoId, {
        kind: "research",
      });
    }
  }
  for (const project of deps.repos.projects.list()) {
    const generation = deps.repos.generations.latestPublished(project.repoId, {
      kind: "research",
    });
    if (generation !== null) return generation;
  }
  return null;
}

function generationKnowledgeDir(
  deps: AppDeps,
  generation: GenerationRecord,
): string {
  return path.isAbsolute(generation.contentDir)
    ? generation.contentDir
    : path.join(deps.paths.knowledge, generation.contentDir);
}

function safeJoin(root: string, relPath: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, relPath);
  if (full !== base && !full.startsWith(`${base}${path.sep}`)) return null;
  return full;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readLessonJson(
  deps: AppDeps,
  generation: GenerationRecord,
  row: LessonRow,
): AnyLesson | null {
  const file = safeJoin(generationKnowledgeDir(deps, generation), row.relPath);
  if (file === null) return null;
  const raw = readJsonFile(file);
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<AnyLesson>;
  if (
    candidate.kind !== "research" &&
    candidate.kind !== "change" &&
    candidate.kind !== "comparison"
  ) {
    return null;
  }
  if (candidate.context === undefined || candidate.diagram === undefined) {
    return null;
  }
  return candidate as AnyLesson;
}

function toLessonSummary(
  row: LessonRow,
  lesson: AnyLesson | null,
): LessonSummary {
  return {
    lessonId: row.lessonId,
    kind: row.kind,
    title: row.title,
    moduleIds: lesson?.context.moduleIds ?? [],
    hasCoverageGaps: (lesson?.coverageGaps.length ?? 0) > 0,
  };
}

function toLessonDetail(lesson: AnyLesson | null): LessonDetailView | null {
  if (lesson === null) return null;
  try {
    return {
      lesson,
      diagram: toRenderData(lesson),
      html: "",
    };
  } catch {
    return null;
  }
}

function readCoverage(
  deps: AppDeps,
  generation: GenerationRecord,
): CoverageReport {
  const file = safeJoin(
    generationKnowledgeDir(deps, generation),
    "coverage.json",
  );
  if (file === null) {
    return emptyCoverage(generation.generationId, generation.commitSha);
  }
  const raw = readJsonFile(file);
  if (typeof raw !== "object" || raw === null) {
    return emptyCoverage(generation.generationId, generation.commitSha);
  }
  const candidate = raw as Partial<CoverageReport>;
  const analyzed = Array.isArray(candidate.analyzed) ? candidate.analyzed : [];
  const gaps = Array.isArray(candidate.gaps) ? candidate.gaps : [];
  const counts = candidate.counts ?? {
    totalFiles: analyzed.length + gaps.length,
    analyzedFiles: analyzed.length,
    excludedFiles: gaps.length,
  };
  return {
    generationId: generation.generationId,
    commitSha: generation.commitSha,
    complete: candidate.complete === true && gaps.length === 0,
    analyzed,
    gaps,
    counts,
    languages: candidate.languages ?? {
      byLanguage: [],
      preferredCoverageOk: false,
    },
  };
}

function toConversationView(
  deps: AppDeps,
  conversationId: string,
): ConversationView | null {
  const record = deps.repos.conversations.byId(
    conversationId as ConversationView["conversationId"],
  );
  if (record === null) return null;
  const messages = deps.repos.conversations.messages(record.conversationId, {
    limit: 100,
  });
  const selections = deps.repos.conversations.selections(record.conversationId);
  const readingPosition =
    deps.repos.prefs
      .readingPositions()
      .find((position) => position.conversationId === record.conversationId) ??
    null;

  return {
    conversationId: record.conversationId,
    generationIds: record.generationIds,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
    messages: messages.map((message: MessageRecord) => ({
      messageId: message.messageId,
      role: message.role,
      content: message.content,
      status: message.status,
      answerPhase: message.answerPhase,
      citations: message.citations.map((citation) => ({
        ...citation,
        availability: "available" as const,
      })),
      selection: message.selection,
      unknownReason: message.unknownReason,
      incomplete: message.incomplete,
      createdAt: message.createdAt,
    })),
    selections: selections.map((selection) => ({
      lessonId: selection.lessonId,
      moduleId: selection.moduleId,
      sourceId: selection.sourceId,
      codeLocation: selection.codeLocation,
      createdAt: selection.createdAt,
    })),
    readingPosition,
  };
}

function buildReaderModel(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
) {
  const generation = resolveGeneration(deps, query);
  if (generation === null) {
    return {
      generationId: "" as GenerationId,
      commitSha: "",
      repoDisplayName: "尚无生成版本",
      lessons: [],
      activeLesson: null,
      coverage: emptyCoverage("" as GenerationId, ""),
      conversation: null,
      readingPosition: null,
      pollingNote: POLLING_NOTE,
    };
  }

  const project =
    generation.projectId === null
      ? null
      : deps.repos.projects.byId(generation.projectId);
  const rows = deps.repos.lessons.listByGeneration(generation.generationId);
  const parsed = rows.map((row) => ({
    row,
    lesson: readLessonJson(deps, generation, row),
  }));
  const summaries = parsed.map(({ row, lesson }) =>
    toLessonSummary(row, lesson),
  );
  const requestedLesson = query.lesson;
  const active =
    (requestedLesson === undefined
      ? undefined
      : parsed.find(({ row }) => row.lessonId === requestedLesson)) ??
    parsed[0];
  const conversation =
    query.conversation === undefined || query.conversation === ""
      ? null
      : toConversationView(deps, query.conversation);
  const readingPosition =
    deps.repos.prefs
      .readingPositions()
      .find((position) => position.generationId === generation.generationId) ??
    null;

  return {
    generationId: generation.generationId,
    commitSha: generation.commitSha,
    repoDisplayName: project?.displayName ?? generation.repoId,
    lessons: summaries,
    activeLesson: active === undefined ? null : toLessonDetail(active.lesson),
    coverage: readCoverage(deps, generation),
    conversation,
    readingPosition,
    pollingNote: POLLING_NOTE,
  };
}

// ── inbox ───────────────────────────────────────────────────────────────────

function changeTitle(change: ChangeRecord): string {
  const pr = change.payload.pr;
  if (pr !== undefined) return pr.title;
  if (change.kind === "history_gap") return "历史缺口";
  if (change.kind === "branch_switch") return "分支切换";
  if (change.kind === "baseline") return "基线";
  if (change.headSha !== null) return `提交 ${change.headSha.slice(0, 12)}`;
  return "变更记录";
}

function toChangeSummary(change: ChangeRecord): ChangeSummary {
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

function resolveProject(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
): ProjectRecord | null {
  const requested = query.project;
  if (requested !== undefined && requested !== "") {
    return deps.repos.projects.byId(requested as ProjectId);
  }
  return deps.repos.projects.list()[0] ?? null;
}

function buildInboxModel(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
) {
  const project = resolveProject(deps, query);
  if (project === null) {
    return {
      projectId: "" as ProjectId,
      items: [],
      next: null,
      pollingNote: POLLING_NOTE,
    };
  }
  const cursor =
    query.cursor === undefined || query.cursor === "" ? null : query.cursor;
  const page = deps.repos.changes.page(project.projectId, cursor, 20);
  return {
    projectId: project.projectId,
    items: page.items.map(toChangeSummary),
    next: page.next,
    pollingNote: POLLING_NOTE,
  };
}

// ── settings ────────────────────────────────────────────────────────────────

function buildSettingsModel(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
): SettingsPageModel {
  const settings = deps.repos.settings.model();
  const pricingConfigured = settings?.pricing != null;
  const project = resolveProject(deps, query);
  let watch: SettingsPageModel["watch"];
  if (project === null) {
    watch = {
      enabled: false,
      available: false,
      reason: "尚无项目，无法开启后台轮询。",
      lastPollAt: null,
    };
  } else if (project.kind === "local") {
    watch = {
      enabled: false,
      available: false,
      reason: "本地项目没有远端可轮询，请使用手动刷新。",
      lastPollAt: null,
    };
  } else {
    const latest = deps.repos.changes.page(project.projectId, null, 1).items[0];
    watch = {
      enabled: project.watchEnabled,
      available: true,
      reason: null,
      lastPollAt: latest?.discoveredAt ?? null,
    };
  }

  return {
    model: toModelSettingsView(settings),
    usage: toUsageView(deps.repos.usage.groupByKind(), pricingConfigured),
    storage: computeStorageReport(deps.paths, deps.repos),
    preferences: {
      preferences: deps.repos.prefs.get(),
      readingPositions: deps.repos.prefs.readingPositions(),
    },
    watch,
    pollingNote: POLLING_NOTE,
  };
}

// ── seam ────────────────────────────────────────────────────────────────────

/**
 * Builds the static-UI seam. The page models are read from `deps.repos`; the
 * renderers are pure functions of those models.
 */
export function createStaticUi(
  deps: AppDeps,
  options: StaticUiOptions = {},
): StaticUiSeam {
  const assetDir = options.assetDir ?? defaultAssetDir();
  const ctx = {
    dataRoot: deps.paths.root,
    assetBase: options.assetBase ?? "/assets",
  };

  return {
    routes: UI_ROUTES,
    handle(req: RouteRequest): Promise<RouteResponse | null> {
      const pathname = req.params.path ?? "/";
      const pattern = req.params.pattern ?? "";

      if (pattern === "/assets/*" || pathname.startsWith("/assets/")) {
        const assetName = pathname.startsWith("/assets/")
          ? pathname.slice("/assets/".length)
          : (req.params["*"] ?? "");
        return Promise.resolve(serveAsset(assetDir, assetName));
      }

      switch (pathname) {
        case "/":
          return Promise.resolve(
            htmlResponse(renderProjectsPage(ctx, buildProjectsModel(deps))),
          );
        case "/learn":
        case "/learn/reader":
          return Promise.resolve(
            htmlResponse(
              renderReaderPage(ctx, buildReaderModel(deps, req.query)),
            ),
          );
        case "/inbox":
          return Promise.resolve(
            htmlResponse(
              renderInboxPage(ctx, buildInboxModel(deps, req.query)),
            ),
          );
        case "/terms":
          return Promise.resolve(
            htmlResponse(
              renderTermsPage(ctx, { terms: deps.repos.terms.list() }),
            ),
          );
        case "/settings":
          return Promise.resolve(
            htmlResponse(
              renderSettingsPage(ctx, buildSettingsModel(deps, req.query)),
            ),
          );
        default:
          return Promise.resolve(null);
      }
    },
  };
}
