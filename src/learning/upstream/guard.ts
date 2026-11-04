/**
 * Protected writes and source drift (architecture §6.5).
 *
 * The adapter generates into a writable per-job build worktree, never into the
 * user's repository, so the analysed checkout stays byte-identical. Two guards
 * make that measurable:
 *
 * - `snapshotProtectedHashes`/`verifyProtectedHashes` record and re-check the
 *   files upstream must never create or edit (`README.md`, `AGENTS.md`,
 *   `.github/workflows/**`, …). A difference fails the job with
 *   `protected_write_blocked` (AC-GEN-15).
 * - `assertNoRepoMutation` and `assertTreeUnchanged` compare a source-tree hash
 *   (excluding `openwiki/**`, which generation legitimately writes) against the
 *   commit tree and fail with `source_drift` when the source moved (AC-GEN-17).
 */

import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { lstat, readdir, readFile, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LearningError } from "../contracts/index.js";
import { git } from "../projects/git.js";

/**
 * Upstream paths this module must never create or modify. `.github/workflows/**`
 * covers every workflow, including `openwiki-update.yml`; the remaining entries
 * are repository-level files upstream can otherwise write during code-mode
 * setup.
 */
export const PROTECTED_WRITE_PATHS: readonly string[] = Object.freeze([
  "openwiki-update.yml",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/workflows/**",
  "README.md",
  ".gitmodules",
  ".gitattributes",
]);

/** Result of comparing a protected-path snapshot with the current tree. */
export interface GuardResult {
  /** First protected path whose content changed, or `null` when clean. */
  blocked: string | null;
}

const WORKFLOWS_DIRECTORY = ".github/workflows";

function toPosix(value: string): string {
  return value.replace(/\\/gu, "/");
}

/** Whether a repository-relative path is protected from upstream writes. */
function isProtectedPath(relativePath: string): boolean {
  const normalized = toPosix(relativePath).replace(/^\.\//u, "");
  if (normalized === WORKFLOWS_DIRECTORY) return true;
  if (normalized.startsWith(`${WORKFLOWS_DIRECTORY}/`)) return true;
  return PROTECTED_WRITE_PATHS.includes(normalized);
}

/**
 * Content digest for one filesystem entry. Missing entries are recorded as `""`
 * so a later *creation* also registers as a change; symlinks hash their target
 * text instead of following it.
 */
async function digestEntry(absolutePath: string): Promise<string> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch {
    return "";
  }
  if (info.isSymbolicLink()) {
    return `symlink:${await readlink(absolutePath)}`;
  }
  if (info.isDirectory()) {
    return "directory";
  }
  if (!info.isFile()) {
    return "";
  }
  const content = await readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

/** Enumerates every file below `relativeDirectory`, sorted for determinism. */
async function listFilesBelow(
  worktreePath: string,
  relativeDirectory: string,
): Promise<string[]> {
  const directory = path.join(worktreePath, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFilesBelow(worktreePath, relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Records a `path -> sha256` map for every protected path in `worktreePath`.
 * Absent paths are recorded with an empty digest so a later write is visible.
 */
export async function snapshotProtectedHashes(
  worktreePath: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const protectedPath of PROTECTED_WRITE_PATHS) {
    if (protectedPath.endsWith("/**")) {
      const directory = protectedPath.slice(0, -3);
      for (const file of await listFilesBelow(worktreePath, directory)) {
        hashes[file] = await digestEntry(path.join(worktreePath, file));
      }
      continue;
    }
    hashes[protectedPath] = await digestEntry(
      path.join(worktreePath, protectedPath),
    );
  }
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

/**
 * Re-snapshots `worktreePath` and reports the first protected path that differs
 * from `before`. Never throws for a changed tree: the caller decides how to fail
 * the job.
 */
export async function verifyProtectedHashes(
  before: Record<string, string>,
  worktreePath: string,
): Promise<GuardResult> {
  const current = await snapshotProtectedHashes(worktreePath);
  const candidates = new Set([
    ...Object.keys(before),
    ...Object.keys(current),
  ]);
  for (const candidate of [...candidates].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if ((before[candidate] ?? "") !== (current[candidate] ?? "")) {
      return { blocked: candidate };
    }
  }
  return { blocked: null };
}

/**
 * Watches a worktree for writes to a protected path and invokes `onViolation`.
 * Returns a stop function; a platform without recursive watch support yields a
 * no-op stopper (the post-run `verifyProtectedHashes` check still applies).
 */
export function watchProtectedWrites(
  worktreePath: string,
  onViolation: (path: string) => void,
): () => void {
  try {
    const watcher = watch(
      worktreePath,
      { recursive: true },
      (_event, filename) => {
        if (typeof filename !== "string" || filename === "") return;
        const relative = toPosix(filename);
        if (isProtectedPath(relative)) onViolation(relative);
      },
    );
    return () => {
      watcher.close();
    };
  } catch {
    return () => {};
  }
}

/**
 * Hashes the source portion of the working tree (including uncommitted and
 * untracked files) through a throwaway Git index. The index is seeded from HEAD
 * and `openwiki/**` is excluded from the update, so generated wiki output is
 * measured as it was at the target commit: a clean source hashes exactly to
 * `git rev-parse <commit>^{tree}`, while any source write changes it.
 */
export async function workingTreeHash(worktreePath: string): Promise<string> {
  const indexFile = path.join(
    os.tmpdir(),
    `codetrail-worktree-index-${process.pid}-${randomUUID()}.tmp`,
  );
  const environment = { GIT_INDEX_FILE: indexFile };
  try {
    const read = await git(worktreePath, ["read-tree", "HEAD"], {
      env: environment,
    });
    if (read.code !== 0) {
      throw new LearningError("object_unavailable", "无法读取工作树 HEAD", {
        worktreePath,
        stderr: read.stderr,
      });
    }
    const add = await git(
      worktreePath,
      ["add", "-A", "--", ".", ":(exclude)openwiki"],
      { env: environment },
    );
    if (add.code !== 0) {
      throw new LearningError("object_unavailable", "无法计算工作树快照", {
        worktreePath,
        stderr: add.stderr,
      });
    }
    const write = await git(worktreePath, ["write-tree"], {
      env: environment,
    });
    const tree = write.stdout.trim();
    if (write.code !== 0 || tree === "") {
      throw new LearningError("object_unavailable", "无法写入工作树快照", {
        worktreePath,
        stderr: write.stderr,
      });
    }
    return tree;
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Verifies that the build worktree's source tree still hashes to
 * `expectedTreeHash`. `openwiki/**` is excluded, so the wiki the run just
 * generated never registers as drift (AC-GEN-17).
 */
export async function assertTreeUnchanged(
  buildWorktree: string,
  expectedTreeHash: string,
): Promise<void> {
  let actual: string;
  try {
    actual = await workingTreeHash(buildWorktree);
  } catch (error) {
    throw new LearningError("source_drift", "无法读取构建工作树", {
      worktreePath: buildWorktree,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (actual !== expectedTreeHash) {
    throw new LearningError("source_drift", "来源内容已变化", {
      expected: expectedTreeHash,
      actual,
    });
  }
}

/**
 * Verifies that the user's repository still hashes to `before`. Used after
 * every job: generation must never mutate the checkout it analyses
 * (AC-GEN-17).
 */
export async function assertNoRepoMutation(
  userRepoPath: string,
  before: string,
): Promise<void> {
  let actual: string;
  try {
    actual = await workingTreeHash(userRepoPath);
  } catch (error) {
    throw new LearningError("source_drift", "无法校验来源仓库", {
      path: userRepoPath,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (actual !== before) {
    throw new LearningError("source_drift", "来源内容已变化", {
      expected: before,
      actual,
    });
  }
}
