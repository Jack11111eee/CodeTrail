/**
 * Diff computation over the local mirror (architecture §12.4).
 *
 * GitHub's `/compare` endpoint is deliberately not used: it truncates at 300
 * files and a single response is not a source of truth (AC-UPD-22). Every diff
 * this module returns is computed from the objects already present in the
 * system mirror with `git diff --name-status -z`; a missing object is reported
 * as a gap instead of being silently dropped.
 */

import { LearningError } from "../contracts/index.js";
import type { DiffEntry, DiffResult } from "../contracts/index.js";
import { git } from "../projects/index.js";
import type { MirrorHandle } from "../projects/index.js";

// Declared in contracts/change.ts (§3.6); re-export only.
export type { DiffEntry, DiffResult };

/** Maps a `--name-status` letter to the stored status vocabulary. */
export function statusFromLetter(letter: string): DiffEntry["status"] | null {
  switch (letter.charAt(0).toUpperCase()) {
    // A copy creates a new path; callers only need A/M/D/R.
    case "A":
    case "C":
      return "A";
    case "M":
    case "T":
      return "M";
    case "D":
      return "D";
    case "R":
      return "R";
    default:
      return null;
  }
}

/**
 * Parses `git diff --name-status -z` output. Rename/copy entries carry two
 * paths; everything else carries one. Exported so the unit test can exercise
 * the parser without spawning Git.
 */
export function parseNameStatus(output: string): DiffEntry[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: DiffEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const status = statusFromLetter(fields[index] ?? "");
    index += 1;
    if (status === null) continue;
    if (status === "R") {
      const oldPath = fields[index];
      const newPath = fields[index + 1];
      index += 2;
      if (newPath !== undefined) {
        entries.push({ path: newPath, status, oldPath });
      }
      continue;
    }
    const file = fields[index];
    index += 1;
    if (file !== undefined) entries.push({ path: file, status });
  }
  return entries;
}

/** True when the object (commit, tree or blob) named by `sha` is present. */
async function objectPresent(
  mirror: MirrorHandle,
  sha: string,
): Promise<boolean> {
  const result = await git(mirror.path, ["cat-file", "-e", sha]);
  return result.code === 0;
}

/**
 * `git diff --name-status` between two commits, capped at `maxFiles`.
 *
 * A missing commit object returns an empty entry list plus the missing sha in
 * `gaps`; it is never reported as "no changes". A capped response is flagged
 * with `truncated: true`, so callers can record a gap rather than pretending
 * the change set is complete.
 */
export async function diffBetween(
  mirror: MirrorHandle,
  baseSha: string,
  headSha: string,
  opts: { maxFiles: number },
): Promise<DiffResult> {
  const missing: string[] = [];
  if (!(await objectPresent(mirror, `${baseSha}^{commit}`))) {
    missing.push(baseSha);
  }
  if (!(await objectPresent(mirror, `${headSha}^{commit}`))) {
    missing.push(headSha);
  }
  if (missing.length > 0) {
    return { entries: [], truncated: false, gaps: missing };
  }

  const result = await git(mirror.path, [
    "diff",
    "--name-status",
    "-z",
    baseSha,
    headSha,
  ]);
  if (result.code !== 0) {
    return {
      entries: [],
      truncated: false,
      gaps: [baseSha, headSha],
    };
  }

  const all = parseNameStatus(result.stdout);
  const maxFiles = Math.max(0, opts.maxFiles);
  const entries = all.slice(0, maxFiles);
  return {
    entries,
    truncated: all.length > maxFiles,
    gaps: [],
  };
}

/**
 * Reads the old content of a deleted path from the object store. A missing
 * object is `object_unavailable`, never an empty string (AC-UPD-21).
 */
export async function readDeletedFile(
  mirror: MirrorHandle,
  sha: string,
  path: string,
): Promise<string> {
  const result = await git(mirror.path, ["cat-file", "-p", `${sha}:${path}`]);
  if (result.code !== 0) {
    throw new LearningError("object_unavailable", "无法读取旧版本文件", {
      sha,
      path,
      reason: "object_unavailable",
    });
  }
  return result.stdout;
}

/** Reads any blob at `sha:path`, returning null when the object is absent. */
export async function readFileAt(
  mirror: MirrorHandle,
  sha: string,
  path: string,
): Promise<string | null> {
  const result = await git(mirror.path, ["cat-file", "-p", `${sha}:${path}`]);
  return result.code === 0 ? result.stdout : null;
}
