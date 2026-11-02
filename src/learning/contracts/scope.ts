import { LearningError } from "./errors.js";
import type { GenerationId } from "./ids.js";
import { computeScopeHash } from "./keys.js";

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
  /** `computeScopeHash(...)`. */
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

function normalizePath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function baseName(relPath: string): string {
  const normalized = normalizePath(relPath).replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Minimal POSIX glob → RegExp: `**` crosses directories, `*`/`?` do not. */
function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(ch);
    }
  }
  source += "$";
  return new RegExp(source);
}

function matchesPattern(relPath: string, pattern: string): boolean {
  const re = globToRegExp(normalizePath(pattern));
  if (pattern.includes("/")) {
    return re.test(normalizePath(relPath));
  }
  return re.test(baseName(relPath));
}

function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(relPath, pattern));
}

function hasExcludedDirSegment(relPath: string): boolean {
  return normalizePath(relPath)
    .split("/")
    .some((segment) =>
      (DEFAULT_EXCLUDE_DIRS as readonly string[]).includes(segment),
    );
}

function isScopeIncluded(
  relPath: string,
  scope: ScopeConfig | NormalizedScope,
): boolean {
  const normalized = normalizePath(relPath);
  const included = scope.include.some((pattern) =>
    matchesPattern(normalized, pattern),
  );
  if (!included) {
    return false;
  }
  return !scope.exclude.some((pattern) => matchesPattern(normalized, pattern));
}

export function normalizeScope(input?: Partial<ScopeConfig>): NormalizedScope {
  const base: ScopeConfig = {
    include: [...(input?.include ?? DEFAULT_SCOPE.include)],
    exclude: [...(input?.exclude ?? DEFAULT_SCOPE.exclude)],
    maxFiles: input?.maxFiles ?? DEFAULT_SCOPE.maxFiles,
    maxFileBytes: input?.maxFileBytes ?? DEFAULT_SCOPE.maxFileBytes,
  };
  return { ...base, hash: computeScopeHash(base) };
}

export function classifyPath(
  relPath: string,
  bytes: number,
  scope: NormalizedScope,
  isDir: boolean,
): ExclusionReason | null {
  const normalized = normalizePath(relPath);
  if (
    isDir &&
    (DEFAULT_EXCLUDE_DIRS as readonly string[]).includes(baseName(normalized))
  ) {
    return "excluded_default_dir";
  }
  if (hasExcludedDirSegment(normalized)) {
    return "excluded_default_dir";
  }
  if (matchesAny(normalized, DEFAULT_EXCLUDE_SECRETS)) {
    return "excluded_secret";
  }
  if (matchesAny(normalized, DEFAULT_EXCLUDE_BINARY)) {
    return "excluded_binary";
  }
  if (matchesAny(normalized, DEFAULT_EXCLUDE_DATA)) {
    return "excluded_data";
  }
  if (bytes > scope.maxFileBytes) {
    return "excluded_too_large";
  }
  if (!isScopeIncluded(normalized, scope)) {
    return "excluded_by_scope";
  }
  return null;
}

export function isReadable(relPath: string, scope: NormalizedScope): boolean {
  const normalized = normalizePath(relPath);
  if (hasExcludedDirSegment(normalized)) {
    return false;
  }
  if (matchesAny(normalized, DEFAULT_EXCLUDE_SECRETS)) {
    return false;
  }
  if (matchesAny(normalized, DEFAULT_EXCLUDE_BINARY)) {
    return false;
  }
  if (matchesAny(normalized, DEFAULT_EXCLUDE_DATA)) {
    return false;
  }
  return isScopeIncluded(normalized, scope);
}

export function assertReadable(relPath: string, scope: NormalizedScope): void {
  if (!isReadable(relPath, scope)) {
    throw new LearningError(
      "out_of_scope_path",
      `路径不在读取范围内: ${relPath}`,
      {
        path: relPath,
      },
    );
  }
}

export function languageOf(relPath: string): LanguageId {
  const name = baseName(relPath).toLowerCase();
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".java")) return "java";
  if (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".mts") ||
    name.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (name.endsWith(".vue")) return "vue";
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".rb")) return "ruby";
  if (name.endsWith(".rs")) return "rust";
  if (name.endsWith(".cs")) return "csharp";
  return "other";
}

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
