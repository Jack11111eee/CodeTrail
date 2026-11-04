/**
 * Frozen runtime constants (architecture §4.3).
 *
 * These values are persisted into `generations.upstream_version`,
 * `config_hash` and the settings views, so they must never be computed from the
 * ambient environment or the wall clock. Object/array constants are frozen at
 * runtime as well as typed `readonly` so a later module cannot mutate a shared
 * default by accident.
 */

export const CODETRAIL_VERSION = "0.1.0";

export const UPSTREAM_REPO = "https://github.com/langchain-ai/openwiki";
export const UPSTREAM_COMMIT = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";
export const UPSTREAM_PACKAGE_VERSION = "0.7.2";
/** `<package>+<commit[0..12]>`; hashed into `config_hash` and compared by the baseline planner. */
export const UPSTREAM_VERSION = `${UPSTREAM_PACKAGE_VERSION}+${UPSTREAM_COMMIT.slice(0, 12)}`;

export const PROMPT_TEMPLATE_VERSION = "codetrail-lesson-v1";
export const LESSON_PIPELINE_VERSION = "lp1";
export const SCHEMA_VERSION = 1;

export const MAX_BODY_BYTES = 1024 * 1024;

/** Poll interval for the watch scheduler; `CODETRAIL_WATCH_INTERVAL_MS` overrides it. */
export const DEFAULT_WATCH_INTERVAL_MS = 300_000;
export const PR_OVERLAP_MS = 120_000;
/** Bounds how far back the very first PR window may look when no cursor watermark
 *  exists yet (§12.2 `windowStart`). 7 days. */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Defaults for `DiscoveryOptions` (§3.16). Every test that constructs the object
 *  explicitly MUST use these values unless it is testing paging itself. */
export const DISCOVERY_DEFAULTS = Object.freeze({
  perPage: 100,
  maxPages: 20,
} as const);

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 5_000;

export const MODEL_CONCURRENCY = 2;
export const PAGE_CONCURRENCY = 1;

export const QA_LIMITS = Object.freeze({
  maxToolCalls: 8,
  maxInputTokens: 24_000,
  maxOutputTokens: 4_000,
} as const);

export const LESSON_LIMITS = Object.freeze({
  maxSemanticRepairs: 1,
} as const);

export const GIT_TIMEOUT_MS = 120_000;

export const PREFERRED_LANGUAGES = Object.freeze([
  "python",
  "java",
  "typescript",
  "javascript",
  "vue",
] as const);
