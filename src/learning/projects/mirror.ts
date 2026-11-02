/**
 * Bare mirrors (architecture §5.3).
 *
 * A mirror is the only durable copy of a project's history inside the data
 * directory. Local imports use `--mirror --no-hardlinks` so unpushed commits
 * are preserved and the user's object store is never hard-linked into ours
 * (AC-PRJ-06); GitHub imports fetch an explicit refspec list. A missing object
 * is always reported, never silently read as empty.
 */

import fs from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { mirrorPath } from "../config/paths.js";
import { repoIdFromIdentity } from "../contracts/index.js";
import { LearningError } from "../contracts/index.js";
import type {
  DataPaths,
  GithubCredential,
  RepoId,
  RepoIdentity,
} from "../contracts/index.js";
import { git, gitSync } from "./git.js";

export interface MirrorHandle {
  repoId: RepoId;
  path: string;
  identity: RepoIdentity;
}

export interface CloneMirrorOptions {
  localPath?: string;
  remoteUrl?: string;
  credential?: GithubCredential | null;
}

export interface FetchMirrorOptions {
  remoteUrl: string;
  refspecs: string[];
  credential?: GithubCredential | null;
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** True when `mirrors/<repoId>.git` exists. */
export async function mirrorExists(
  paths: DataPaths,
  repoId: RepoId,
): Promise<boolean> {
  return directoryExists(mirrorPath(paths, repoId));
}

/**
 * Validates a local clone source before Git does, so AC-PRJ-15's
 * unreadable / non-Git / corrupt cases stay distinguishable. Bare repositories
 * are allowed here (unlike `localIdentity`, which requires a work tree).
 */
function assertLocalSource(localPath: string): void {
  if (!path.isAbsolute(localPath)) {
    throw new LearningError("invalid_input", "本地仓库必须使用绝对路径", {
      path: localPath,
    });
  }
  let real: string;
  try {
    real = fs.realpathSync.native(localPath);
  } catch {
    throw new LearningError("invalid_path", "路径不存在或不可读", {
      path: localPath,
      reason: "invalid_path",
    });
  }
  try {
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new LearningError("invalid_path", "路径不可读", {
      path: localPath,
      reason: "invalid_path",
    });
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new LearningError("invalid_path", "路径不是目录", {
      path: localPath,
      reason: "invalid_path",
    });
  }

  const probe = gitSync(real, ["rev-parse", "--git-dir"]);
  if (probe.code !== 0) {
    // A `.git` entry Git cannot read is a corrupt repository; a directory that
    // never had one is simply not a repository (AC-PRJ-15 needs distinct codes).
    if (fs.existsSync(path.join(real, ".git"))) {
      throw new LearningError("object_unavailable", "Git 仓库无法读取", {
        path: real,
      });
    }
    throw new LearningError("invalid_input", "该目录不是 Git 仓库", {
      path: real,
      reason: "not_git_repo",
    });
  }
}

/** Maps a remote Git failure onto the closed error vocabulary. */
function remoteFailure(stderr: string, remoteUrl: string): LearningError {
  const text = stderr.toLowerCase();
  const details = { remoteUrl, stderr };
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("terminal prompts disabled") ||
    text.includes("403") ||
    text.includes("401")
  ) {
    return new LearningError("github_auth_failed", "GitHub 认证失败", details);
  }
  if (
    text.includes("not found") ||
    text.includes("404") ||
    text.includes("repository does not exist") ||
    text.includes("does not appear to be a git repository")
  ) {
    return new LearningError("not_found", "远程仓库不存在", details);
  }
  return new LearningError("object_unavailable", "无法访问远程仓库", details);
}

/**
 * Clones (or reuses) the mirror for `identity`. Reuse is what makes a
 * re-import of the same path cheap and keeps `UNIQUE(identity)` meaningful.
 */
export async function cloneMirror(
  paths: DataPaths,
  identity: RepoIdentity,
  options: CloneMirrorOptions,
): Promise<MirrorHandle> {
  const { localPath, remoteUrl } = options;
  if (localPath !== undefined && remoteUrl !== undefined) {
    throw new LearningError("invalid_input", "只能提供本地路径或远程地址", {
      reason: "local_path_and_url",
    });
  }
  if (localPath === undefined && remoteUrl === undefined) {
    throw new LearningError("invalid_input", "缺少仓库来源", {
      field: "source",
    });
  }

  const repoId = repoIdFromIdentity(identity);
  const target = mirrorPath(paths, repoId);
  await mkdir(paths.mirrors, { recursive: true, mode: 0o700 });

  if (await directoryExists(target)) {
    return { repoId, path: target, identity };
  }

  if (localPath !== undefined) {
    assertLocalSource(localPath);
    const local = await git(
      paths.mirrors,
      ["clone", "--mirror", "--no-hardlinks", "--", localPath, target],
      { credentials: null },
    );
    if (local.code !== 0) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      const text = local.stderr.toLowerCase();
      if (
        text.includes("does not appear to be a git repository") ||
        text.includes("not a git repository") ||
        text.includes("does not exist")
      ) {
        throw new LearningError("invalid_input", "该目录不是 Git 仓库", {
          path: localPath,
          reason: "not_git_repo",
        });
      }
      throw new LearningError("object_unavailable", "无法克隆本地仓库", {
        path: localPath,
        stderr: local.stderr,
      });
    }
    return { repoId, path: target, identity };
  }

  // Both-undefined was rejected above, so a remote URL is present here.
  if (remoteUrl === undefined) {
    throw new LearningError("invalid_input", "缺少仓库来源", {
      field: "source",
    });
  }
  const remote = await git(
    paths.mirrors,
    ["clone", "--mirror", "--", remoteUrl, target],
    { credentials: options.credential ?? null },
  );
  if (remote.code !== 0) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw remoteFailure(remote.stderr, remoteUrl);
  }

  return { repoId, path: target, identity };
}

/** Fetches an explicit refspec list into an existing mirror. */
export async function fetchMirror(
  paths: DataPaths,
  repoId: RepoId,
  options: FetchMirrorOptions,
): Promise<void> {
  const target = mirrorPath(paths, repoId);
  if (!(await directoryExists(target))) {
    throw new LearningError("object_unavailable", "镜像不存在", { repoId });
  }
  const refspecs = options.refspecs.filter((value) => value !== "");
  const result = await git(
    target,
    ["fetch", "--prune", "--", options.remoteUrl, ...refspecs],
    { credentials: options.credential ?? null },
  );
  if (result.code !== 0) {
    throw remoteFailure(result.stderr, options.remoteUrl);
  }
}

/**
 * Reports whether a commit object is present. A missing mirror or a mirror Git
 * cannot read is a structured `object_unavailable`, not `"missing"`.
 */
export async function ensureObjectAvailable(
  handle: MirrorHandle,
  sha: string,
): Promise<"present" | "missing"> {
  if (!(await directoryExists(handle.path))) {
    throw new LearningError("object_unavailable", "镜像不存在", {
      repoId: handle.repoId,
    });
  }
  const result = await git(handle.path, ["cat-file", "-e", `${sha}^{commit}`]);
  if (result.code === 0) {
    return "present";
  }
  const text = result.stderr.toLowerCase();
  if (
    result.code === 1 ||
    text.includes("not a valid object name") ||
    text.includes("bad object") ||
    text.includes("could not get object")
  ) {
    return "missing";
  }
  throw new LearningError("object_unavailable", "镜像无法读取", {
    repoId: handle.repoId,
    sha,
    stderr: result.stderr,
  });
}

/** True when `sha` names any object in the mirror. */
export async function catFileExists(
  handle: MirrorHandle,
  sha: string,
): Promise<boolean> {
  if (!(await directoryExists(handle.path))) {
    return false;
  }
  const result = await git(handle.path, ["cat-file", "-e", sha]);
  return result.code === 0;
}
