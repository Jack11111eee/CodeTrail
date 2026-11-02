/**
 * The `projects/` barrel.
 *
 * Contracts remain the source of types; this barrel exposes the runtime
 * services built on them. `LanguageId` is deliberately exported from one place
 * only (`scope.ts`) to keep the module graph unambiguous.
 */

export * from "./coverage.js";
export * from "./git.js";
export * from "./identity.js";
export * from "./mirror.js";
export * from "./removal.js";
export * from "./snapshot.js";
export * from "./worktree.js";

export {
  DEFAULT_EXCLUDE_BINARY,
  DEFAULT_EXCLUDE_DATA,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_SECRETS,
  DEFAULT_SCOPE,
  assertReadable,
  classifyPath,
  isReadable,
  languageOf,
  normalizeScope,
} from "./scope.js";
export type {
  ExclusionReason,
  LanguageId,
  NormalizedScope,
  ScopeConfig,
} from "./scope.js";

export { evidenceSlicesFor, isBestEffort, splitVueSfc } from "./languages.js";
export type {
  EvidenceSlice,
  LanguageReport,
  VueBlock,
  VueRegion,
} from "./languages.js";
