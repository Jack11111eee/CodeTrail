/**
 * Coverage report assembly (architecture §5.7).
 *
 * Every enumerated entry is either analysed or reported as a gap, so no path
 * can silently disappear from the generation input (AC-PRJ-09). `complete` is
 * derived from `gaps.length` in exactly one place, which makes
 * `complete === true && gaps.length > 0` unreachable (AC-PRJ-16).
 *
 * Submodules are never descended into: a gitlink (`mode 160000`) or a path
 * declared in `.gitmodules` is `submodule_not_fetched`. LFS pointers keep their
 * pointer bytes and become `lfs_not_fetched`; the content is never rewritten
 * (AC-PRJ-11). Secret and binary files are classified before any blob read, so
 * their content is never inspected.
 */

import { PREFERRED_LANGUAGES } from "../config/defaults.js";
import type {
  CoverageReport,
  ExclusionReason,
  GenerationId,
  LanguageId,
  NormalizedScope,
} from "../contracts/index.js";
import { isBestEffort } from "./languages.js";
import { classifyPath, languageOf } from "./scope.js";

/** One raw `git ls-tree -r -z --long` row. */
export interface CoverageEntry {
  path: string;
  bytes: number;
  mode: string;
  type: string;
}

/** Import-time working-tree state; these paths never enter the analysis. */
export interface CoverageStatus {
  uncommitted: string[];
  untracked: string[];
}

export interface CoverageInput {
  generationId: GenerationId;
  commitSha: string;
  scope: NormalizedScope;
  entries: readonly CoverageEntry[];
  readBlob: (relPath: string) => Promise<string>;
  status?: CoverageStatus;
}

interface Gap {
  path: string;
  reason: ExclusionReason;
  bytes: number;
  detail?: string;
}

const SUBMODULE_MODE = "160000";
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** An LFS pointer is far smaller than this; larger blobs are never sniffed. */
const MAX_LFS_POINTER_BYTES = 1024;

function normalizeRel(relPath: string): string {
  return relPath
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
}

function byPath(left: Gap, right: Gap): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isSafeRepoPath(relPath: string): boolean {
  if (relPath === "" || relPath.startsWith("/") || relPath.includes("\0")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/u.test(relPath)) {
    return false;
  }
  return !relPath.split("/").includes("..");
}

function parseGitmodules(content: string): string[] {
  const paths: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/u.exec(line);
    if (match !== null) {
      const normalized = normalizeRel(match[1]);
      if (isSafeRepoPath(normalized)) {
        paths.push(normalized);
      }
    }
  }
  return paths;
}

function isUnderSubmodule(
  relPath: string,
  submodules: ReadonlySet<string>,
): boolean {
  for (const submodule of submodules) {
    if (relPath === submodule || relPath.startsWith(`${submodule}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the report from committed tree entries plus the optional import-time
 * status. `maxFiles` overflow is a gap (`excluded_by_scope` with
 * `detail: "max_files_exceeded"`), never a silent drop.
 */
export async function buildCoverageReport(
  input: CoverageInput,
): Promise<CoverageReport> {
  const { generationId, commitSha, scope, readBlob, status } = input;

  const gaps = new Map<string, Gap>();
  const addGap = (
    relPath: string,
    reason: ExclusionReason,
    bytes: number,
    detail?: string,
  ): void => {
    const path = normalizeRel(relPath);
    if (path === "" || gaps.has(path)) {
      return;
    }
    gaps.set(
      path,
      detail === undefined
        ? { path, reason, bytes }
        : { path, reason, bytes, detail },
    );
  };

  // `-r` lists blobs and gitlinks; trees are not files and are never reported.
  const unique = new Map<string, CoverageEntry>();
  for (const entry of input.entries) {
    if (entry.type === "tree") {
      continue;
    }
    const path = normalizeRel(entry.path);
    if (path !== "" && !unique.has(path)) {
      unique.set(path, { ...entry, path });
    }
  }
  const files = [...unique.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  // `.gitmodules` presence means the declared paths are submodules even when
  // Git omitted the gitlink entry (for example in a shallow mirror).
  const declaredSubmodules = new Set<string>();
  const gitmodules = files.find((entry) => entry.path === ".gitmodules");
  if (
    gitmodules !== undefined &&
    classifyPath(gitmodules.path, gitmodules.bytes, scope, false) === null
  ) {
    try {
      for (const path of parseGitmodules(await readBlob(".gitmodules"))) {
        declaredSubmodules.add(path);
      }
    } catch {
      // An unreadable `.gitmodules` is reported through its own entry; the
      // gitlink rule below still covers a real mode-160000 row.
    }
  }

  const candidates: CoverageEntry[] = [];
  for (const entry of files) {
    if (
      entry.mode === SUBMODULE_MODE ||
      entry.type === "commit" ||
      isUnderSubmodule(entry.path, declaredSubmodules)
    ) {
      addGap(entry.path, "submodule_not_fetched", entry.bytes);
      continue;
    }
    const reason = classifyPath(entry.path, entry.bytes, scope, false);
    if (reason !== null) {
      addGap(entry.path, reason, entry.bytes);
      continue;
    }
    candidates.push(entry);
  }
  for (const submodule of declaredSubmodules) {
    addGap(submodule, "submodule_not_fetched", 0);
  }

  const limit = Math.max(0, Math.trunc(scope.maxFiles));
  const withinLimit = candidates.slice(0, limit);
  const overflow = candidates.slice(limit);

  const analyzed: { path: string; bytes: number; language: LanguageId }[] = [];
  for (const entry of withinLimit) {
    let header = "";
    if (entry.bytes < MAX_LFS_POINTER_BYTES) {
      try {
        header = await readBlob(entry.path);
      } catch {
        // A missing/unreadable blob is not a pointer; the read path reports it.
      }
    }
    if (header.startsWith(LFS_POINTER_PREFIX)) {
      addGap(entry.path, "lfs_not_fetched", entry.bytes);
      continue;
    }
    analyzed.push({
      path: entry.path,
      bytes: entry.bytes,
      language: languageOf(entry.path),
    });
  }
  for (const entry of overflow) {
    addGap(entry.path, "excluded_by_scope", entry.bytes, "max_files_exceeded");
  }

  if (status !== undefined) {
    for (const path of status.uncommitted) {
      addGap(path, "uncommitted_excluded", 0);
    }
    for (const path of status.untracked) {
      addGap(path, "untracked_excluded", 0);
    }
  }

  const sortedGaps = [...gaps.values()].sort(byPath);

  const languageTotals = new Map<
    LanguageId,
    { files: number; bytes: number }
  >();
  for (const entry of analyzed) {
    const total = languageTotals.get(entry.language) ?? { files: 0, bytes: 0 };
    total.files += 1;
    total.bytes += entry.bytes;
    languageTotals.set(entry.language, total);
  }
  const byLanguage = [...languageTotals.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([language, totals]) => ({
      language,
      files: totals.files,
      bytes: totals.bytes,
      bestEffort: isBestEffort(language),
    }));

  return {
    generationId,
    commitSha,
    complete: sortedGaps.length === 0,
    analyzed,
    gaps: sortedGaps,
    counts: {
      // Every entry (plus an import-time dirty path) is either analysed or a
      // gap; the two lists are the single source for this total.
      totalFiles: analyzed.length + sortedGaps.length,
      analyzedFiles: analyzed.length,
      excludedFiles: sortedGaps.length,
    },
    languages: {
      byLanguage,
      preferredCoverageOk: PREFERRED_LANGUAGES.every((language) =>
        languageTotals.has(language),
      ),
    },
  };
}
