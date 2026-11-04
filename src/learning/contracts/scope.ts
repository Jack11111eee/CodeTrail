import type { GenerationId } from "./ids.js";

/**
 * Read-scope and coverage types (architecture §3.10).
 *
 * This module is the declaration layer only. `projects/scope.ts` re-exports
 * these types and tables and owns the behaviour (`normalizeScope`,
 * `classifyPath`, `isReadable`, `assertReadable`, `languageOf`); the leaf rule
 * forbids contracts from importing the Git/filesystem plumbing those need.
 */

export type LanguageId =
  | "python"
  | "java"
  | "typescript"
  | "javascript"
  | "vue"
  | "go"
  | "ruby"
  | "rust"
  | "csharp"
  | "other";

export interface ScopeConfig {
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxFileBytes: number;
}

export interface NormalizedScope extends ScopeConfig {
  /** `computeScopeHash(...)` — include/exclude are sorted before hashing. */
  hash: string;
}

export type ExclusionReason =
  | "excluded_default_dir"
  | "excluded_secret"
  | "excluded_binary"
  | "excluded_data"
  | "excluded_too_large"
  | "excluded_by_scope"
  | "submodule_not_fetched"
  | "lfs_not_fetched"
  | "uncommitted_excluded"
  | "untracked_excluded";

export const DEFAULT_EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  ".idea",
] as const;

export const DEFAULT_EXCLUDE_SECRETS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "credentials.json",
  "id_rsa*",
] as const;

export const DEFAULT_EXCLUDE_BINARY = [
  "*.bin",
  "*.pt",
  "*.onnx",
  "*.safetensors",
  "*.so",
  "*.dylib",
  "*.dll",
  "*.exe",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.pdf",
  "*.woff2",
] as const;

/** `*.csv` is deliberately KEPT (small, readable). */
export const DEFAULT_EXCLUDE_DATA = [
  "*.parquet",
  "*.sqlite",
  "*.db",
  "*.h5",
  "*.pkl",
  "*.npy",
] as const;

export const DEFAULT_SCOPE: Readonly<ScopeConfig> = {
  include: ["**/*"],
  exclude: [],
  maxFiles: 5000,
  maxFileBytes: 5 * 1024 * 1024,
};

// ── coverage (moved here from §5.7 — `SnapshotService` and `BuildLessonsInput` take it) ──
export interface LanguageReport {
  byLanguage: {
    language: LanguageId;
    files: number;
    bytes: number;
    bestEffort: boolean;
  }[];
  /** python+java+ts+js+vue all present ⇒ true. */
  preferredCoverageOk: boolean;
}

export interface CoverageReport {
  generationId: GenerationId;
  commitSha: string;
  /** === gaps.length === 0 (AC-PRJ-16). */
  complete: boolean;
  analyzed: { path: string; bytes: number; language: LanguageId }[];
  gaps: {
    path: string;
    reason: ExclusionReason;
    bytes: number;
    detail?: string;
  }[];
  counts: { totalFiles: number; analyzedFiles: number; excludedFiles: number };
  languages: LanguageReport;
}
