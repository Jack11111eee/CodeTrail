/**
 * Change-lesson entry point and significance rules (architecture §12.6).
 *
 * The heavy lifting lives in `lessons/builder.ts` (`mode: "change"`). This
 * module is the **builder entry consumed by the `change_analysis` pipeline**
 * and owns the two rules discovery needs before any model call:
 *
 * - a wording/format-only diff may become a `short` record (AC-UPD-23), and
 * - config / schema / design-rule edits are **always** `full`, regardless of
 *   their file suffix (AC-UPD-24).
 *
 * Events are never deleted here; the event-side invariant lives in discovery.
 */

import type {
  BuildChangeLessonInput,
  BuildLessonsResult,
  DiffEntry,
  LessonBuilderPort,
  Significance,
} from "../contracts/index.js";
import {
  buildChangeLesson as coreBuildChangeLesson,
  buildComparisonLesson,
  buildResearchLessons,
  type BuildLessonServices,
} from "../lessons/index.js";

// A change lesson is built by the canonical builder; re-export so callers only
// import from this component's barrel.
export { buildChangeLesson } from "../lessons/index.js";
export type { BuildChangeLessonInput, BuildLessonsResult };

/** Config, schema and design-rule files can never be downgraded to `short`. */
const ALWAYS_FULL_PATTERNS: readonly RegExp[] = [
  /(^|\/)config(\.[^/]+)?$/iu,
  /\.(toml|ya?ml|ini|properties|xml|env)$/iu,
  /(^|\/)[^/]*schema[^/]*$/iu,
  /\.sql$/iu,
  /(^|\/)(design|architecture)([^/]*)$/iu,
  /(^|\/)AGENTS\.md$/iu,
  /(^|\/)CLAUDE\.md$/iu,
];

/** Pure prose paths are candidates for a short record. */
const PROSE_PATTERNS: readonly RegExp[] = [
  /\.(md|markdown|txt|rst|adoc)$/iu,
  /(^|\/)(docs?|documentation|wiki)\//iu,
];

export function isConfigOrSchemaPath(path: string): boolean {
  return ALWAYS_FULL_PATTERNS.some((pattern) => pattern.test(path));
}

export function isProsePath(path: string): boolean {
  return PROSE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Removes comments and whitespace so two versions that differ only in wording
 * or formatting compare equal. Deliberately conservative: it never changes an
 * identifier, literal or expression.
 */
export function normalizeForWording(path: string, text: string): string {
  let result = text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  if (/\.(py|sh|rb|ya?ml|toml|conf)$/iu.test(path)) {
    result = result.replace(/#[^\n]*/gu, "");
  } else if (!/\.(md|markdown|txt|rst|adoc)$/iu.test(path)) {
    result = result.replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  }
  return result.replace(/\s+/gu, "");
}

export interface SignificanceReaders {
  readBase?: (path: string) => Promise<string | null>;
  readHead?: (path: string) => Promise<string | null>;
}

/**
 * Classifies a diff. `short` means "pure wording/format", `full` means the
 * change can affect behaviour (and is the safe default).
 */
export async function classifySignificance(
  entries: readonly DiffEntry[],
  readers: SignificanceReaders = {},
): Promise<Significance> {
  if (entries.length === 0) return "short";
  if (entries.some((entry) => isConfigOrSchemaPath(entry.path))) return "full";

  for (const entry of entries) {
    if (entry.status === "A" || entry.status === "D") {
      if (!isProsePath(entry.path)) return "full";
      continue;
    }
    if (entry.status === "R") {
      const oldPath = entry.oldPath ?? entry.path;
      if (!isProsePath(entry.path) && !isProsePath(oldPath)) return "full";
      continue;
    }
    // M: prose edits are wording by nature; code only qualifies when the
    // non-comment, non-whitespace content is identical.
    if (isProsePath(entry.path)) continue;
    if (!readers.readBase || !readers.readHead) return "full";
    const before = await readers.readBase(entry.path);
    const after = await readers.readHead(entry.path);
    if (before === null || after === null) return "full";
    if (
      normalizeForWording(entry.path, before) !==
      normalizeForWording(entry.path, after)
    ) {
      return "full";
    }
  }
  return "short";
}

/**
 * Synchronous path-only variant used where blob contents are not available.
 * It can only prove `short` for prose-only diffs; code always stays `full`.
 */
export function classifySignificancePaths(
  entries: readonly DiffEntry[],
): Significance {
  if (entries.length === 0) return "short";
  if (entries.some((entry) => isConfigOrSchemaPath(entry.path))) return "full";
  return entries.every((entry) => isProsePath(entry.path)) ? "short" : "full";
}

/**
 * The `LessonBuilderPort` implementation the composition root can inject. All
 * three modes delegate to the canonical builders; only the change mode gains
 * the six `ChangeRecordFields` (enforced by `ChangeLessonSchema`).
 */
export function createChangeLessonBuilder(
  services: BuildLessonServices = {},
): LessonBuilderPort {
  return {
    buildResearchLessons: (input) => buildResearchLessons(input, services),
    buildChangeLesson: (input) => coreBuildChangeLesson(input, services),
    buildComparisonLesson: (input) => buildComparisonLesson(input, services),
  };
}

/** Builds one change lesson through the canonical builder. */
export function buildChangeLessonForEvent(
  input: BuildChangeLessonInput,
  services: BuildLessonServices = {},
): Promise<BuildLessonsResult> {
  return coreBuildChangeLesson(input, services);
}
