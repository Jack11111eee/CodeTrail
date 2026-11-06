import { requireTopic, toTopicView } from "./routes/topics.js";
import { lessonTitle } from "../lessons/title.js";
import { loadModelKey } from "../config/model-credentials.js";
import { LearningError } from "../contracts/index.js";
import {
  generationProjectState,
  requirePublishedGeneration,
  readSourceView,
} from "./routes/generations.js";
/**
 * The static-UI seam (architecture §14.1, §15).
 *
 * `UI_ROUTES` is declared separately from the API routes so the API
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

import { toChangeSummary } from "./routes/changes.js";
import { toUsageView, computeStorageReport } from "./routes/ops.js";
import { toModelSettingsView } from "./routes/settings.js";
import type {
  AppDeps,
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
import { latestProjectJob } from "./jobs/project-job.js";
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

const HTML_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
});

const ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "styles.css": "text/css; charset=utf-8",
  "client.js": "text/javascript; charset=utf-8",
  "theme.js": "text/javascript; charset=utf-8",
});

export interface StaticUiOptions {
  /** Directory holding `styles.css` and the compiled `client.js`. */
  assetDir?: string;
  /** Same-origin prefix; defaults to `/assets`. */
  assetBase?: string;
}

/**
 * Locates the browser assets. The compiled bundle lives beside the compiled
 * server (`dist/learning/ui`), which is also the right answer under `tsx` dev:
 * `src/learning/ui` has only `client.ts`, so serving it would 404 on
 * `client.js`. Prefer a directory that actually contains the bundle, then fall
 * back to the sibling path.
 */
function defaultAssetDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.resolve(here, "..", "ui");
  if (fs.existsSync(path.join(built, "client.js"))) return built;
  const fromSource = path.resolve(
    here,
    "..",
    "..",
    "..",
    "dist",
    "learning",
    "ui",
  );
  if (fs.existsSync(path.join(fromSource, "client.js"))) return fromSource;
  return built;
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

function toProjectSummary(
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
    // A generation without a coverage report is *unknown*, not complete: the
    // reader must never claim a full-repository analysis it cannot prove.
    complete: false,
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
    return requirePublishedGeneration(deps, requested as GenerationId);
  }
  const requestedProject = query.project;
  if (requestedProject !== undefined && requestedProject !== "") {
    const project = deps.repos.projects.byId(requestedProject as ProjectId);
    if (project === null) throw new LearningError("not_found", "项目不存在");
    if (project.deletedAt !== null)
      throw new LearningError("source_removed", "项目已被移除");
    return deps.repos.generations.latestPublished(project.repoId, {
      kind: "research",
    });
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
    title: lessonTitle(row.title, row.kind, lesson),
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
        availability: (() => {
          const owner = deps.repos.generations.byId(citation.generationId);
          return owner === null
            ? ("source_missing" as const)
            : generationProjectState(deps, owner) === "removed"
              ? ("source_removed" as const)
              : ("available" as const);
        })(),
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

async function buildReaderModel(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
) {
  const generation = resolveGeneration(deps, query);
  if (generation === null) {
    return {
      generationId: "" as GenerationId,
      commitSha: "",
      projectId: (query.project as ProjectId | undefined) ?? null,
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
  const selectedTopic = query.topic ? requireTopic(deps, query.topic) : null;
  if (selectedTopic && selectedTopic.generationId !== generation.generationId)
    throw new LearningError("version_mismatch", "学习主题不属于当前分析版本");
  const activeTopic = selectedTopic ? toTopicView(deps, selectedTopic) : null;
  const allTopics = generation.projectId
    ? deps.repos.topics.listByProject(generation.projectId, {
        includeDeleted: true,
      })
    : deps.repos.topics.listByGeneration(generation.generationId, {
        includeDeleted: true,
      });
  const allRows = deps.repos.lessons.listByGeneration(generation.generationId, {
    includeDeleted: true,
  });
  const rows = allRows.filter((row) => !row.deletedAt);
  const deletedLessons = allRows
    .filter((row) => row.deletedAt)
    .map((row) => toLessonSummary(row, readLessonJson(deps, generation, row)));
  const parsed = rows.map((row) => ({
    row,
    lesson: readLessonJson(deps, generation, row),
  }));
  const summaries = parsed.map(({ row, lesson }) =>
    toLessonSummary(row, lesson),
  );
  const requestedLesson = query.lesson;
  if (
    requestedLesson &&
    !parsed.some(({ row }) => row.lessonId === requestedLesson)
  ) {
    if (deletedLessons.some((lesson) => lesson.lessonId === requestedLesson))
      throw new LearningError(
        "source_removed",
        "这篇讲解已删除，可在学习目录中恢复",
        { reason: "lesson_deleted", generationId: generation.generationId },
      );
    throw new LearningError("version_mismatch", "讲解不属于当前版本");
  }
  const active = activeTopic
    ? undefined
    : ((requestedLesson === undefined
        ? undefined
        : parsed.find(({ row }) => row.lessonId === requestedLesson)) ??
      parsed[0]);
  const conversation = activeTopic
    ? toConversationView(deps, activeTopic.conversationId)
    : query.conversation === undefined || query.conversation === ""
      ? null
      : toConversationView(deps, query.conversation);
  if (
    conversation &&
    !conversation.generationIds.includes(generation.generationId)
  )
    throw new LearningError("version_mismatch", "会话不属于当前版本");
  const readingPosition =
    deps.repos.prefs
      .readingPositions()
      .find(
        (position) =>
          position.generationId === generation.generationId &&
          position.lessonId === active?.row.lessonId,
      ) ?? null;
  const source = query.source
    ? await readSourceView(deps, generation.generationId, query.source as never)
    : null;

  return {
    projectId: generation.projectId,
    source,
    generationId: generation.generationId,
    commitSha: generation.commitSha,
    repoDisplayName: project?.displayName ?? generation.repoId,
    lessons: summaries,
    deletedLessons,
    topics: allTopics.filter((topic) => !topic.deletedAt),
    deletedTopics: allTopics.filter((topic) => topic.deletedAt),
    activeTopic,
    activeLesson: active === undefined ? null : toLessonDetail(active.lesson),
    coverage: readCoverage(deps, generation),
    conversation,
    readingPosition,
    pollingNote: POLLING_NOTE,
  };
}

// ── inbox ───────────────────────────────────────────────────────────────────

function resolveProject(
  deps: AppDeps,
  query: Readonly<Record<string, string>>,
): ProjectRecord | null {
  const requested = query.project;
  if (requested !== undefined && requested !== "") {
    const project = deps.repos.projects.byId(requested as ProjectId);
    if (!project) throw new LearningError("not_found", "项目不存在");
    if (project.deletedAt)
      throw new LearningError("source_removed", "项目已被移除");
    return project;
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
    projectName: project.displayName,
    projects: deps.repos.projects
      .list()
      .map(({ projectId, displayName }) => ({ projectId, displayName })),
    items: page.items.map((item) => ({
      ...toChangeSummary(item),
      generationId: item.jobId
        ? (deps.repos.jobs.byId(item.jobId)?.outputGenerationId ?? null)
        : null,
    })),
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
      reason: "本地项目不支持后台轮询。请回到项目页选择新提交并重新分析。",
      lastPollAt: null,
    };
  } else {
    watch = {
      enabled: project.watchEnabled,
      available: true,
      reason: null,
      lastPollAt:
        deps.watch?.lastPollAt(project.projectId) ??
        deps.repos.cursors?.get(project.repoId, "default_branch", "discovery")
          ?.lastPollAt ??
        null,
    };
  }

  return {
    projectId: project?.projectId ?? "",
    model: toModelSettingsView(
      settings,
      Boolean(loadModelKey(deps.paths, process.env)),
    ),
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
    async handle(req: RouteRequest): Promise<RouteResponse | null> {
      const pathname = req.params.path ?? "/";
      const pattern = req.params.pattern ?? "";

      if (pattern === "/assets/*" || pathname.startsWith("/assets/")) {
        const assetName = pathname.startsWith("/assets/")
          ? pathname.slice("/assets/".length)
          : (req.params["*"] ?? "");
        return Promise.resolve(serveAsset(assetDir, assetName));
      }

      const pageCtx = { ...ctx, projectId: req.query.project };
      switch (pathname) {
        case "/":
          return Promise.resolve(
            htmlResponse(renderProjectsPage(ctx, buildProjectsModel(deps))),
          );
        case "/learn":
        case "/learn/reader":
          return Promise.resolve(
            htmlResponse(
              renderReaderPage(ctx, await buildReaderModel(deps, req.query)),
            ),
          );
        case "/inbox":
          return Promise.resolve(
            htmlResponse(
              renderInboxPage(pageCtx, buildInboxModel(deps, req.query)),
            ),
          );
        case "/terms":
          return Promise.resolve(
            htmlResponse(
              renderTermsPage(pageCtx, { terms: deps.repos.terms.list() }),
            ),
          );
        case "/settings":
          return Promise.resolve(
            htmlResponse(
              renderSettingsPage(pageCtx, buildSettingsModel(deps, req.query)),
            ),
          );
        default:
          return Promise.resolve(null);
      }
    },
  };
}
