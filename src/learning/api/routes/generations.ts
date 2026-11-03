/**
 * Published generation reads: lesson list/detail, one source and the coverage
 * report (architecture §5.8, §6.3, §9, §14.1, §3.8).
 *
 * Resolution order is normative and is the same for all four routes:
 *
 *   1. row absent                     → `404 not_found`
 *   2. row present but not published  → `409 unpublished_generation`
 *   3. row present + project removed  → `410 source_removed`
 *      (`details.reason = "project_removed"`)
 *   4. otherwise                      → serve the sealed content
 *
 * There is deliberately no redirect: a removed link never resolves to the
 * newest generation (AC-PRJ-14, AC-R16-02). A lesson or source id that belongs
 * to another generation is a `409 version_mismatch` naming the owner, never a
 * silent 404 (AC-API-04).
 */

import fs from "node:fs";
import path from "node:path";

import { LearningError, errorMessageFor, sliceLines } from "../../contracts/index.js";
import type {
  AppDeps,
  CoverageReport,
  GenerationId,
  GenerationRecord,
  HandlerFactory,
  LessonDetailView,
  LessonId,
  LessonListView,
  LessonRow,
  LessonSummary,
  ProjectState,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
  SourceId,
  SourceRef,
  SourceStatus,
  SourceView,
} from "../../contracts/index.js";
import { lessonToMarkdown, toRenderData } from "../../lessons/index.js";
import type { AnyLesson } from "../../lessons/index.js";
import { normalizeScope } from "../../projects/index.js";
import { renderMarkdownSafe } from "../../ui/render/markdown.js";
import {
  generationKnowledgeDir,
  readCoverageReport,
  removalServiceFor,
} from "./projects.js";

export const routes: readonly RouteDef[] = [
  {
    method: "GET",
    pattern: "/api/generations/:id/lessons",
    auth: "session",
    handler: "generations.lessons",
  },
  {
    method: "GET",
    pattern: "/api/generations/:id/lessons/:lessonId",
    auth: "session",
    handler: "generations.lesson",
  },
  {
    method: "GET",
    pattern: "/api/generations/:id/sources/:sourceId",
    auth: "session",
    handler: "generations.source",
  },
  {
    method: "GET",
    pattern: "/api/generations/:id/coverage",
    auth: "session",
    handler: "generations.coverage",
  },
];

/** One source is never allowed to inflate an HTTP body without bound. */
const MAX_SOURCE_BYTES = 1024 * 1024;

function notFound(details: Record<string, unknown>): LearningError {
  return new LearningError("not_found", errorMessageFor("not_found", "zh"), details);
}

function unpublished(generation: GenerationRecord): LearningError {
  return new LearningError(
    "unpublished_generation",
    errorMessageFor("unpublished_generation", "zh"),
    { generationId: generation.generationId, status: generation.status },
  );
}

function removedGeneration(generation: GenerationRecord): LearningError {
  return new LearningError(
    "source_removed",
    errorMessageFor("source_removed", "zh"),
    {
      reason: "project_removed",
      generationId: generation.generationId,
      projectId: generation.projectId,
    },
  );
}

/**
 * §5.8: a generation may lack `project_id` (comparison and legacy rows); the
 * project is then resolved through `projects.repo_id` restricted to removed
 * rows, so a single match is enough to answer 410 rather than redirect.
 */
export function generationProjectState(
  deps: AppDeps,
  generation: GenerationRecord,
): ProjectState {
  const removal = removalServiceFor(deps);
  if (generation.projectId !== null) {
    const state = removal.state(generation.projectId);
    if (state !== "unknown") return state;
  }
  const row = deps.db.raw
    .prepare(
      `SELECT 1 AS found FROM projects
       WHERE repo_id = ? AND deleted_at IS NOT NULL LIMIT 1`,
    )
    .get(generation.repoId);
  return row === undefined ? "active" : "removed";
}

/**
 * Read-time citation availability (§5.8, §3.11 rule 4).
 *
 * Exposed for the conversation routes, which annotate every citation with it
 * on read: history of a removed project stays readable, but each citation is
 * marked `source_removed` rather than silently pointing at new content.
 */
export function citationAvailability(
  deps: AppDeps,
  generationId: GenerationId | null,
): SourceStatus {
  if (generationId === null) return "available";
  const generation = deps.repos.generations.byId(generationId);
  if (generation === null) return "source_removed";
  return generationProjectState(deps, generation) === "removed"
    ? "source_removed"
    : "available";
}

/**
 * Applies the four-step resolution order. A removed project is checked after
 * publication so a staged row still reports `409 unpublished_generation`.
 */
export function requirePublishedGeneration(
  deps: AppDeps,
  generationId: GenerationId,
): GenerationRecord {
  const generation = deps.repos.generations.byId(generationId);
  if (generation === null) {
    throw notFound({ generationId });
  }
  if (generation.status !== "published") {
    throw unpublished(generation);
  }
  if (generationProjectState(deps, generation) === "removed") {
    throw removedGeneration(generation);
  }
  return generation;
}

function safeJoin(root: string, relPath: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, relPath);
  if (full !== base && !full.startsWith(`${base}${path.sep}`)) return null;
  return full;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readLesson(
  deps: AppDeps,
  generation: GenerationRecord,
  row: LessonRow,
): AnyLesson | null {
  const file = safeJoin(
    generationKnowledgeDir(deps, generation.contentDir),
    row.relPath,
  );
  if (file === null) return null;
  const raw = readJson(file);
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

function ownerGenerationOfLesson(
  deps: AppDeps,
  lessonId: LessonId,
): GenerationId | null {
  const row = deps.db.raw
    .prepare("SELECT generation_id FROM lessons WHERE lesson_id = ? LIMIT 1")
    .get(lessonId) as { generation_id: string } | undefined;
  return row === undefined ? null : (row.generation_id as GenerationId);
}

function ownerGenerationOfSource(
  deps: AppDeps,
  sourceId: SourceId,
): GenerationId | null {
  const row = deps.db.raw
    .prepare("SELECT generation_id FROM sources WHERE source_id = ? LIMIT 1")
    .get(sourceId) as { generation_id: string } | undefined;
  return row === undefined ? null : (row.generation_id as GenerationId);
}

function versionMismatch(
  message: string,
  details: Record<string, unknown>,
): LearningError {
  return new LearningError("version_mismatch", message, details);
}

function projectScope(deps: AppDeps, generation: GenerationRecord) {
  const project =
    generation.projectId === null
      ? deps.repos.projects.liveProjectForRepo(generation.repoId)
      : deps.repos.projects.byId(generation.projectId);
  return project?.scope ?? normalizeScope();
}

// ── lessons ─────────────────────────────────────────────────────────────────

const listLessons: HandlerFactory = (deps) => (req) => {
  const generation = requirePublishedGeneration(
    deps,
    req.params.id as GenerationId,
  );
  const lessons = deps.repos.lessons
    .listByGeneration(generation.generationId)
    .map((row) => toLessonSummary(row, readLesson(deps, generation, row)));
  const body: LessonListView = {
    generationId: generation.generationId,
    commitSha: generation.commitSha,
    lessons,
  };
  return Promise.resolve({ kind: "json", status: 200, body });
};

const getLesson: HandlerFactory = (deps) => (req) => {
  const generation = requirePublishedGeneration(
    deps,
    req.params.id as GenerationId,
  );
  const lessonId = req.params.lessonId as LessonId;
  const row = deps.repos.lessons.byId(generation.generationId, lessonId);
  if (row === null) {
    const owner = ownerGenerationOfLesson(deps, lessonId);
    if (owner !== null && owner !== generation.generationId) {
      throw versionMismatch("讲解不属于该生成版本", {
        lessonId,
        generationId: generation.generationId,
        ownerGenerationId: owner,
      });
    }
    throw notFound({ lessonId, generationId: generation.generationId });
  }

  const lesson = readLesson(deps, generation, row);
  if (lesson === null) {
    throw notFound({
      lessonId,
      generationId: generation.generationId,
      reason: "lesson_file_unreadable",
    });
  }

  let html = "";
  try {
    html = renderMarkdownSafe(
      lessonToMarkdown(lesson, deps.registry.all(generation.generationId)),
    );
  } catch {
    // A render failure must not turn a published read into a 500: the
    // structured lesson and its diagram are still served.
  }

  const body: LessonDetailView = {
    lesson,
    diagram: toRenderData(lesson),
    html,
  };
  return Promise.resolve({ kind: "json", status: 200, body });
};

// ── sources ─────────────────────────────────────────────────────────────────

function sourceLabel(ref: SourceRef): string {
  if (ref.kind === "repo") {
    return ref.lines === null
      ? `${ref.path}@${ref.commitSha.slice(0, 12)}`
      : `${ref.path}:${ref.lines.start}-${ref.lines.end}@${ref.commitSha.slice(0, 12)}`;
  }
  if (ref.kind === "external") return ref.title;
  return ref.label;
}

const getSource: HandlerFactory = (deps) => async (req) => {
  const generation = requirePublishedGeneration(
    deps,
    req.params.id as GenerationId,
  );
  const sourceId = req.params.sourceId as SourceId;
  const row = deps.repos.sources.get(generation.generationId, sourceId);
  if (row === null) {
    const owner = ownerGenerationOfSource(deps, sourceId);
    if (owner !== null && owner !== generation.generationId) {
      throw versionMismatch("来源不属于该生成版本", {
        sourceId,
        generationId: generation.generationId,
        ownerGenerationId: owner,
      });
    }
    throw notFound({ sourceId, generationId: generation.generationId });
  }

  let ref: SourceRef;
  try {
    ref = JSON.parse(row.payloadJson) as SourceRef;
  } catch {
    throw new LearningError("internal_error", "来源记录无法解析", {
      sourceId,
    });
  }

  let content = "";
  let availability: SourceView["availability"] = "available";

  if (ref.kind === "repo") {
    const snapshot = await deps.snapshotService.ensure(
      ref.repoId,
      ref.commitSha,
    );
    const text = await deps.snapshotService.readFile(
      snapshot,
      ref.path,
      projectScope(deps, generation),
    );
    content = ref.lines === null ? text : sliceLines(text, ref.lines);
  } else if (ref.kind === "external") {
    const text = await deps.external.cached(ref.contentHash);
    if (text === null) {
      availability = "source_missing";
    } else {
      content = text;
    }
  } else {
    content = ref.label;
  }

  const truncated = content.length > MAX_SOURCE_BYTES;
  if (truncated) content = content.slice(0, MAX_SOURCE_BYTES);

  const body: SourceView = {
    generationId: generation.generationId,
    sourceId,
    kind: ref.kind,
    commitSha: row.commitSha,
    label: sourceLabel(ref),
    content,
    lines: ref.kind === "repo" ? ref.lines : null,
    truncated,
    availability,
  };
  return { kind: "json", status: 200, body };
};

// ── coverage ────────────────────────────────────────────────────────────────

const getCoverage: HandlerFactory = (deps) => (req) => {
  const generation = requirePublishedGeneration(
    deps,
    req.params.id as GenerationId,
  );
  const body: CoverageReport = readCoverageReport(
    deps,
    generation.generationId,
    generation.contentDir,
    generation.commitSha,
  );
  return Promise.resolve({ kind: "json", status: 200, body });
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "generations.lessons": listLessons,
  "generations.lesson": getLesson,
  "generations.source": getSource,
  "generations.coverage": getCoverage,
};

export const generationsRoutes: RouteModule = {
  id: "generations",
  routes,
  handlers,
};
