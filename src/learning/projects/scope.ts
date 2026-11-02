/**
 * Read scope (architecture §5.5).
 *
 * `normalizeScope` fixes the hash-visible shape of a scope; `classifyPath`
 * explains why a committed path may not enter a generation; `assertReadable`
 * is the single choke point every read path goes through. Paths are always
 * interpreted as POSIX-style paths relative to the worktree root, and the
 * default tables come from `contracts/scope.ts` (§3.10) — they are re-exported
 * here, never redeclared.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

import { computeScopeHash, LearningError } from "../contracts/index.js";
import {
  DEFAULT_EXCLUDE_BINARY,
  DEFAULT_EXCLUDE_DATA,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_SECRETS,
  DEFAULT_SCOPE,
} from "../contracts/index.js";
import type {
  ExclusionReason,
  LanguageId,
  NormalizedScope,
  ScopeConfig,
} from "../contracts/index.js";

export type { ExclusionReason, LanguageId, NormalizedScope, ScopeConfig };
export {
  DEFAULT_EXCLUDE_BINARY,
  DEFAULT_EXCLUDE_DATA,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_SECRETS,
  DEFAULT_SCOPE,
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
  return /[.*+?^${}()|[\]\\]/u.test(ch) ? `\\${ch}` : ch;
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
  return new RegExp(source, "u");
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

/** Absolute paths and `..` traversal are rejected before any `fs` call. */
function isUnsafeRelPath(relPath: string): boolean {
  if (typeof relPath !== "string" || relPath === "" || relPath.includes("\0")) {
    return true;
  }
  if (path.isAbsolute(relPath) || /^[\\/]/u.test(relPath)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/u.test(relPath)) {
    return true;
  }
  return relPath.split(/[\\/]+/u).some((segment) => segment === "..");
}

function normalizePatternList(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const normalized = normalizePath(pattern.trim());
    if (normalized !== "") {
      seen.add(normalized);
    }
  }
  return [...seen].sort();
}

function boundedInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

/**
 * Fills defaults and sorts the pattern lists so the same logical scope always
 * produces the same `hash`, independent of the order the caller supplied.
 */
export function normalizeScope(input?: Partial<ScopeConfig>): NormalizedScope {
  const base: ScopeConfig = {
    include: normalizePatternList(input?.include ?? DEFAULT_SCOPE.include),
    exclude: normalizePatternList(input?.exclude ?? DEFAULT_SCOPE.exclude),
    maxFiles: boundedInteger(input?.maxFiles ?? DEFAULT_SCOPE.maxFiles, 0),
    maxFileBytes: boundedInteger(
      input?.maxFileBytes ?? DEFAULT_SCOPE.maxFileBytes,
      0,
    ),
  };
  return { ...base, hash: computeScopeHash(base) };
}

/**
 * Returns the reason `relPath` may not enter a generation, or `null` when it
 * may. Directory, secret, binary, data and size rules are applied in that
 * order; a caller-supplied include/exclude list wins last.
 */
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

/** Non-throwing form of `assertReadable`; also rejects traversal shapes. */
export function isReadable(relPath: string, scope: NormalizedScope): boolean {
  if (isUnsafeRelPath(relPath)) {
    return false;
  }
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

function outOfScope(
  relPath: string,
  extra?: Record<string, unknown>,
): LearningError {
  return new LearningError("out_of_scope_path", "路径超出允许范围", {
    path: relPath,
    ...extra,
  });
}

/**
 * `fs.realpath` containment: the resolved target must stay inside `root`.
 * Missing targets are left to the read, which reports `not_found`; a resolved
 * target outside the root is always `symlink_escape`.
 */
function assertInsideRoot(relPath: string, root: string): void {
  const absolute = path.resolve(root, relPath);
  const lexical = path.relative(root, absolute);
  if (
    lexical === "" ||
    lexical === ".." ||
    lexical.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexical)
  ) {
    throw outOfScope(relPath);
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(absolute);
  } catch {
    return;
  }
  const resolved = path.relative(realRoot, realTarget);
  if (
    resolved === ".." ||
    resolved.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolved)
  ) {
    throw outOfScope(relPath, { reason: "symlink_escape" });
  }
}

/**
 * The single readability choke point (AC-SEC-11). Static rejections (absolute
 * paths, `..`, secrets, excluded directories, out-of-scope paths) happen before
 * any filesystem access; only a path that passes them is `realpath`-checked
 * against `root` when a root is supplied.
 */
export function assertReadable(
  relPath: string,
  scope: NormalizedScope,
  root?: string,
): void {
  if (isUnsafeRelPath(relPath)) {
    throw outOfScope(relPath);
  }
  if (!isReadable(relPath, scope)) {
    throw outOfScope(relPath);
  }
  if (root !== undefined) {
    assertInsideRoot(relPath, root);
  }
}

/** Maps a file name to its language; unknown suffixes are `other`. */
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
