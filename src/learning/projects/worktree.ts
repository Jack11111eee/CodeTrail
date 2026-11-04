/**
 * Immutable worktrees and the `SnapshotReader` (architecture §5.4, §5.5).
 *
 * A read worktree is a detached checkout at `work/<repoId>/<sha>`. Once created
 * every directory and file loses its write bits, so a snapshot cannot change
 * underneath a published lesson (AC-PRJ-12). The build worktree lives at
 * `staging/<jobId>/tree`, stays writable and is removed after publish/GC; its
 * path comes from `stagingTreePath` so config and publisher cannot drift.
 *
 * Enumeration is always `git ls-tree` against the commit, never a filesystem
 * walk, which is what keeps uncommitted and untracked files out of the
 * analysis (AC-PRJ-06).
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stagingPath, stagingTreePath, worktreePath } from "../config/paths.js";
import { LearningError } from "../contracts/index.js";
import type {
  DataPaths,
  JobId,
  NormalizedScope,
  RepoId,
  SnapshotReader,
  SnapshotRecord,
} from "../contracts/index.js";
import { git } from "./git.js";
import type { MirrorHandle } from "./mirror.js";
import { assertReadable, classifyPath } from "./scope.js";

export interface WorktreeHandle {
  repoId: RepoId;
  commitSha: string;
  treeHash: string;
  /** `<data>/work/<repoId>/<sha>` */
  path: string;
  readOnly: true;
}

/** One row of `git ls-tree -r -z --long`. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  object: string;
  bytes: number;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function unknownRef(ref: string, detail?: string): LearningError {
  const details: Record<string, unknown> = { ref, reason: "unknown_ref" };
  if (detail !== undefined) {
    details.detail = detail;
  }
  return new LearningError("invalid_input", "无法解析该引用", details);
}

async function objectExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Removes write bits from every directory and file below `root`. */
async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await makeTreeReadOnly(child);
      await chmod(child, 0o555);
    } else {
      await chmod(child, 0o444);
    }
  }
  await chmod(root, 0o555);
}

/** Restores owner write bits so a stale tree can be deleted. */
async function makeTreeWritable(root: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await makeTreeWritable(child);
      await chmod(child, 0o755).catch(() => undefined);
    } else {
      await chmod(child, 0o644).catch(() => undefined);
    }
  }
  await chmod(root, 0o755).catch(() => undefined);
}

async function removeTree(root: string): Promise<void> {
  if (!(await objectExists(root))) {
    return;
  }
  await makeTreeWritable(root);
  await rm(root, { recursive: true, force: true });
}

/**
 * Resolves a branch, tag, full SHA or unique short SHA to a full 40-hex SHA.
 * `^{commit}` peels annotated tags; unknown or non-commit refs are
 * `invalid_input` with `details.reason = "unknown_ref"`.
 */
export async function resolveRef(
  handle: MirrorHandle,
  ref: string,
): Promise<string> {
  const value = ref.trim();
  if (value === "" || value.startsWith("-")) {
    throw unknownRef(ref);
  }
  const result = await git(handle.path, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${value}^{commit}`,
  ]);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !SHA_PATTERN.test(sha)) {
    throw unknownRef(ref, result.stderr);
  }
  return sha;
}

/** `git rev-parse <sha>^{tree}`. */
export async function treeHashOf(
  handle: MirrorHandle,
  sha: string,
): Promise<string> {
  const result = await git(handle.path, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${sha}^{tree}`,
  ]);
  const tree = result.stdout.trim();
  if (result.code !== 0 || !SHA_PATTERN.test(tree)) {
    throw new LearningError("object_unavailable", "无法读取 Git 树对象", {
      repoId: handle.repoId,
      sha,
      stderr: result.stderr,
    });
  }
  return tree;
}

/** Enumerates committed entries straight from Git (`ls-tree -r -z --long`). */
export async function listTreeEntries(
  worktreeOrMirror: string,
  sha: string,
): Promise<TreeEntry[]> {
  const result = await git(worktreeOrMirror, [
    "ls-tree",
    "-r",
    "-z",
    "--long",
    sha,
  ]);
  if (result.code !== 0) {
    throw new LearningError("object_unavailable", "无法枚举 Git 树", {
      sha,
      stderr: result.stderr,
    });
  }
  const entries: TreeEntry[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/ +/u);
    if (meta.length < 4) continue;
    const [mode, type, object, size] = meta;
    const bytes = size === "-" ? 0 : Number.parseInt(size, 10);
    entries.push({
      path: record.slice(tab + 1),
      mode,
      type: type as TreeEntry["type"],
      object,
      bytes: Number.isFinite(bytes) ? bytes : 0,
    });
  }
  return entries;
}

/** True when `candidate` is a worktree checked out at `sha`. */
async function isWorktreeAt(candidate: string, sha: string): Promise<boolean> {
  if (!(await directoryExists(candidate))) {
    return false;
  }
  if (!(await objectExists(path.join(candidate, ".git")))) {
    return false;
  }
  const result = await git(candidate, ["rev-parse", "HEAD"]);
  return result.code === 0 && result.stdout.trim() === sha;
}

/** `true` when the immutable worktree for `(repoId, sha)` is already present. */
export async function worktreeMatches(
  paths: DataPaths,
  repoId: RepoId,
  sha: string,
): Promise<boolean> {
  return isWorktreeAt(worktreePath(paths, repoId, sha), sha);
}

/**
 * Creates (or reuses) the detached, read-only worktree for a commit. The path
 * is a pure function of `(repoId, sha)`, so re-ensuring the same commit reuses
 * the same directory (AC-PRJ-12).
 */
export async function ensureWorktree(
  paths: DataPaths,
  handle: MirrorHandle,
  sha: string,
): Promise<WorktreeHandle> {
  const target = worktreePath(paths, handle.repoId, sha);
  const treeHash = await treeHashOf(handle, sha);

  if (await isWorktreeAt(target, sha)) {
    return {
      repoId: handle.repoId,
      commitSha: sha,
      treeHash,
      path: target,
      readOnly: true,
    };
  }

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (await objectExists(target)) {
    // A half-created directory would make `worktree add` refuse the path.
    await removeTree(target);
    await git(handle.path, ["worktree", "prune"]);
  }

  const result = await git(handle.path, [
    "worktree",
    "add",
    "--detach",
    target,
    sha,
  ]);
  if (result.code !== 0) {
    throw new LearningError("object_unavailable", "无法创建快照工作树", {
      repoId: handle.repoId,
      sha,
      stderr: result.stderr,
    });
  }

  await makeTreeReadOnly(target);
  return {
    repoId: handle.repoId,
    commitSha: sha,
    treeHash,
    path: target,
    readOnly: true,
  };
}

/**
 * Creates (or reuses) the writable build worktree at `staging/<jobId>/tree`.
 * The path is never constructed here: it comes from `stagingTreePath`, which
 * `Publisher.buildWorkspace` also uses.
 */
export async function ensureBuildWorktree(
  paths: DataPaths,
  handle: MirrorHandle,
  sha: string,
  jobId: JobId,
): Promise<{ path: string }> {
  const target = stagingTreePath(paths, jobId);

  if (await isWorktreeAt(target, sha)) {
    return { path: target };
  }

  if (await objectExists(target)) {
    await git(handle.path, ["worktree", "remove", "--force", target]);
    await removeTree(target);
    await git(handle.path, ["worktree", "prune"]);
  }

  await mkdir(stagingPath(paths, jobId), { recursive: true, mode: 0o700 });
  const result = await git(handle.path, [
    "worktree",
    "add",
    "--detach",
    target,
    sha,
  ]);
  if (result.code !== 0) {
    throw new LearningError("object_unavailable", "无法创建构建工作树", {
      repoId: handle.repoId,
      sha,
      jobId,
      stderr: result.stderr,
    });
  }
  return { path: target };
}

/** Deletes `staging/<jobId>` in full; safe when it never existed. */
export async function removeBuildWorktree(
  paths: DataPaths,
  jobId: JobId,
): Promise<void> {
  await rm(stagingPath(paths, jobId), { recursive: true, force: true }).catch(
    async () => {
      await removeTree(stagingPath(paths, jobId));
    },
  );
}

/**
 * Recomputes the working-tree hash (including uncommitted changes) through a
 * throwaway index and compares it with the commit's tree. A difference means
 * something wrote into the build tree before publish (AC-GEN-17).
 */
export async function assertTreeUnchanged(
  worktreePathToCheck: string,
  expectedTreeHash: string,
): Promise<void> {
  const indexFile = path.join(
    os.tmpdir(),
    `codetrail-index-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const read = await git(worktreePathToCheck, ["read-tree", "HEAD"], {
      env: { GIT_INDEX_FILE: indexFile },
    });
    if (read.code !== 0) {
      throw new LearningError("source_drift", "无法读取构建工作树", {
        worktreePath: worktreePathToCheck,
        stderr: read.stderr,
      });
    }
    const add = await git(worktreePathToCheck, ["add", "-A"], {
      env: { GIT_INDEX_FILE: indexFile },
    });
    if (add.code !== 0) {
      throw new LearningError("source_drift", "无法计算构建工作树快照", {
        worktreePath: worktreePathToCheck,
        stderr: add.stderr,
      });
    }
    const write = await git(worktreePathToCheck, ["write-tree"], {
      env: { GIT_INDEX_FILE: indexFile },
    });
    const actual = write.stdout.trim();
    if (write.code !== 0 || actual !== expectedTreeHash) {
      throw new LearningError("source_drift", "来源内容已变化", {
        expected: expectedTreeHash,
        actual,
      });
    }
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

function notFound(relPath: string): LearningError {
  return new LearningError("not_found", "文件不存在", { path: relPath });
}

/**
 * Binds a snapshot to a read scope. Reads and slices pass through
 * `assertReadable` with the worktree root, so `..`, absolute paths,
 * out-of-scope paths and symlink escapes all fail before a file is opened;
 * enumeration uses `git ls-tree` so untracked files are invisible by
 * construction.
 */
export function createSnapshotReader(
  record: SnapshotRecord,
  scope: NormalizedScope,
): SnapshotReader {
  const root = record.worktreePath;

  async function read(relPath: string): Promise<string> {
    assertReadable(relPath, scope, root);
    try {
      return await readFile(path.resolve(root, relPath), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
        throw notFound(relPath);
      }
      throw error;
    }
  }

  return {
    repoId: record.repoId,
    commitSha: record.commitSha,
    treeHash: record.treeHash,
    read,
    async exists(relPath: string): Promise<boolean> {
      try {
        assertReadable(relPath, scope, root);
      } catch {
        return false;
      }
      try {
        const stats = await stat(path.resolve(root, relPath));
        return stats.isFile();
      } catch {
        return false;
      }
    },
    async slice(
      relPath: string,
      lines: { start: number; end: number },
    ): Promise<string> {
      const text = await read(relPath);
      const all = text.split(/\r?\n/u);
      const start = Math.max(1, Math.trunc(lines.start));
      const end = Math.max(start, Math.trunc(lines.end));
      return all.slice(start - 1, end).join("\n");
    },
    async list(
      listScope: NormalizedScope,
    ): Promise<{ path: string; bytes: number }[]> {
      const entries = await listTreeEntries(root, record.commitSha);
      return entries
        .filter((entry) => entry.type === "blob")
        .filter(
          (entry) =>
            classifyPath(entry.path, entry.bytes, listScope, false) === null,
        )
        .map((entry) => ({ path: entry.path, bytes: entry.bytes }))
        .sort((left, right) => left.path.localeCompare(right.path));
    },
  };
}
