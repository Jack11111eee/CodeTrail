/**
 * The single data-directory path algebra (architecture §4.2).
 *
 * `DataPaths` is declared in `contracts/foundation.ts`; this module re-exports
 * the type and is the only place that turns a root into concrete directories.
 * There is exactly one per-job build area — `staging/<jobId>/{tree,knowledge}`
 * — and `stagingPath`/`stagingTreePath`/`stagingKnowledgePath` are its only
 * constructors. `assertInsideDataDir` is the sandbox check every write path
 * goes through.
 */

import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LearningError } from "../contracts/index.js";
import type {
  DataPaths,
  GenerationId,
  JobId,
  RepoId,
} from "../contracts/index.js";

export type { DataPaths };

/** Default root when `CODETRAIL_DATA_DIR` is absent. */
const DEFAULT_DIR_NAME = ".codetrail";

/** Expands a leading `~` so the env var accepts the shell spelling users type. */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Resolves `candidate` to a real path, following symlinks in the portion that
 * exists and preserving the remainder. The data directory is created lazily, so
 * a plain `realpathSync` cannot be used on a fresh install.
 */
function canonicalize(candidate: string): string {
  let current = path.resolve(candidate);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `value` contains a `..` path segment (either separator). */
function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === "..");
}

/**
 * Rejects an id that could change the meaning of a joined path. Ids are opaque
 * branded strings, but a caller may still pass a hand-written one.
 */
function safeSegment(value: string, label: string): string {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new LearningError(
      "invalid_input",
      `${label} is not a valid path segment`,
      {
        field: label,
      },
    );
  }
  return value;
}

/**
 * Computes every directory under the single writable root. `CODETRAIL_DATA_DIR`
 * is honoured (and resolved absolutely); otherwise `~/.codetrail` is used.
 */
export function resolveDataPaths(env: NodeJS.ProcessEnv): DataPaths {
  const configured = env.CODETRAIL_DATA_DIR;
  const base =
    typeof configured === "string" && configured.trim() !== ""
      ? expandHome(configured.trim())
      : path.join(os.homedir(), DEFAULT_DIR_NAME);
  const root = canonicalize(base);
  return {
    root,
    db: path.join(root, "db", "codetrail.sqlite"),
    mirrors: path.join(root, "mirrors"),
    work: path.join(root, "work"),
    knowledge: path.join(root, "knowledge"),
    staging: path.join(root, "staging"),
    external: path.join(root, "external"),
    logs: path.join(root, "logs"),
    backups: path.join(root, "backups"),
    credentials: path.join(root, "credentials.json"),
    session: path.join(root, "session.json"),
    openwikiHome: path.join(root, "openwiki-home"),
  };
}

/** Creates the data root and every managed directory with owner-only access. */
export async function ensureDataDir(paths: DataPaths): Promise<void> {
  const directories = [
    paths.root,
    path.dirname(paths.db),
    paths.mirrors,
    paths.work,
    paths.knowledge,
    paths.staging,
    paths.external,
    paths.logs,
    paths.backups,
    paths.openwikiHome,
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

/** `mirrors/<repoId>.git` */
export function mirrorPath(paths: DataPaths, repoId: RepoId): string {
  return path.join(paths.mirrors, `${safeSegment(repoId, "repoId")}.git`);
}

/** `work/<repoId>/<sha>` */
export function worktreePath(
  paths: DataPaths,
  repoId: RepoId,
  sha: string,
): string {
  return path.join(
    paths.work,
    safeSegment(repoId, "repoId"),
    safeSegment(sha, "sha"),
  );
}

/** `knowledge/<generationId>` */
export function knowledgePath(
  paths: DataPaths,
  generationId: GenerationId,
): string {
  return path.join(paths.knowledge, safeSegment(generationId, "generationId"));
}

/** `staging/<jobId>` — the only per-job build area. */
export function stagingPath(paths: DataPaths, jobId: JobId): string {
  return path.join(paths.staging, safeSegment(jobId, "jobId"));
}

/** `staging/<jobId>/tree` — the writable build worktree. */
export function stagingTreePath(paths: DataPaths, jobId: JobId): string {
  return path.join(stagingPath(paths, jobId), "tree");
}

/** `staging/<jobId>/knowledge` — the staged knowledge root. */
export function stagingKnowledgePath(paths: DataPaths, jobId: JobId): string {
  return path.join(stagingPath(paths, jobId), "knowledge");
}

/**
 * Returns the canonical path of `candidate`, or throws `out_of_scope_path`.
 *
 * Rejected: any `..` segment, an absolute path outside `root`, a relative path
 * that resolves outside `root`, and a symlink (anywhere on the path) whose real
 * target leaves `root`.
 */
export function assertInsideDataDir(
  paths: DataPaths,
  candidate: string,
): string {
  if (
    typeof candidate !== "string" ||
    candidate === "" ||
    candidate.includes("\0")
  ) {
    throw new LearningError("out_of_scope_path", "路径超出允许范围", {
      path: candidate,
    });
  }
  if (hasTraversal(candidate)) {
    throw new LearningError("out_of_scope_path", "路径超出允许范围", {
      path: candidate,
    });
  }

  const root = canonicalize(paths.root);
  const resolved = path.resolve(root, candidate);
  const relativeToRoot = path.relative(root, resolved);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new LearningError("out_of_scope_path", "路径超出允许范围", {
      path: candidate,
    });
  }

  const canonical = canonicalize(resolved);
  const relativeToRealRoot = path.relative(root, canonical);
  if (
    relativeToRealRoot === ".." ||
    relativeToRealRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRealRoot)
  ) {
    throw new LearningError("out_of_scope_path", "路径超出允许范围", {
      path: candidate,
      reason: "symlink_escape",
    });
  }
  return canonical;
}
