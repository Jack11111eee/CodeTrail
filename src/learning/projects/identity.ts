/**
 * Repository identity (architecture §5.1).
 *
 * A repository is identified by exactly one canonical string:
 * `local:<realpath>` or `github:<owner>/<repo>` (owner/repo lowercased for the
 * key only). `localIdentity` is the only place that accepts an absolute
 * filesystem path (AC-PRJ-03), and it insists the path is the root of a Git
 * work tree so a subdirectory can never become a separate project.
 */

import fs from "node:fs";
import path from "node:path";

import { LearningError } from "../contracts/index.js";
import type { RepoIdentity, RepoKind } from "../contracts/index.js";
import { gitSync } from "./git.js";

// Declared in contracts/refs.ts (§3.9); re-export only, never redeclare.
export type { RepoIdentity, RepoKind };

const GITHUB_PREFIX = "github:";
const LOCAL_PREFIX = "local:";

function invalidIdentity(message: string, details?: Record<string, unknown>) {
  return new LearningError("invalid_input", message, details);
}

function isSafeSegment(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

/** The canonical `github:<owner>/<repo>` key. */
export function githubIdentity(owner: string, repo: string): RepoIdentity {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepo = repo
    .trim()
    .toLowerCase()
    .replace(/\.git$/u, "");
  if (!isSafeSegment(normalizedOwner) || !isSafeSegment(normalizedRepo)) {
    throw invalidIdentity("GitHub 仓库标识无效", { owner, repo });
  }
  return `${GITHUB_PREFIX}${normalizedOwner}/${normalizedRepo}`;
}

/** Splits any canonical identity into its kind and value. */
export function parseIdentity(identity: RepoIdentity): {
  kind: RepoKind;
  value: string;
} {
  if (identity.startsWith(LOCAL_PREFIX)) {
    return { kind: "local", value: identity.slice(LOCAL_PREFIX.length) };
  }
  if (identity.startsWith(GITHUB_PREFIX)) {
    return { kind: "github", value: identity.slice(GITHUB_PREFIX.length) };
  }
  throw invalidIdentity("无法识别的仓库标识", { identity });
}

/** A human-readable label for the UI; never used as a key. */
export function displayNameOf(identity: RepoIdentity): string {
  const { kind, value } = parseIdentity(identity);
  if (kind === "github") {
    return value;
  }
  return path.basename(value) || value;
}

function splitPathSegments(value: string): string[] {
  return value.split("/").filter((segment) => segment !== "");
}

/**
 * Accepts the four spellings users paste from GitHub plus an optional
 * `/tree/<ref>` suffix. Any other host is rejected with
 * `details.reason = "unsupported_host"`.
 */
export function normalizeGithubUrl(input: string): {
  owner: string;
  repo: string;
  url: string;
} {
  const raw = input.trim();
  if (raw === "") {
    throw invalidIdentity("GitHub 地址为空", { input });
  }

  // Strip a query string or fragment before looking at the path.
  const withoutSuffix = raw.split(/[?#]/u, 1)[0];

  let host: string;
  let rest: string;
  const scpLike = /^git@([^:]+):(.+)$/u.exec(withoutSuffix);
  if (scpLike !== null) {
    host = scpLike[1];
    rest = scpLike[2];
  } else {
    const schemeLike = /^(?:https?|ssh|git):\/\/([^/]+)\/(.+)$/u.exec(
      withoutSuffix,
    );
    if (schemeLike !== null) {
      host = schemeLike[1];
      rest = schemeLike[2];
    } else {
      const bare = /^([^/:]+)\/(.+)$/u.exec(withoutSuffix);
      if (bare === null) {
        throw invalidIdentity("无法识别的 GitHub 地址", {
          input,
          reason: "unsupported_host",
        });
      }
      host = bare[1];
      rest = bare[2];
    }
  }

  const normalizedHost = host.toLowerCase();
  if (normalizedHost !== "github.com" && normalizedHost !== "www.github.com") {
    throw invalidIdentity("只支持 github.com 地址", {
      input,
      reason: "unsupported_host",
    });
  }

  const segments = splitPathSegments(rest);
  if (segments.length < 2) {
    throw invalidIdentity("GitHub 地址缺少 owner/repo", { input });
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/u, "");
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    throw invalidIdentity("GitHub 地址无效", { input });
  }

  const trailing = segments.slice(2);
  // `/tree/<ref>` is tolerated: the ref is what the caller will resolve later.
  if (trailing.length > 0 && trailing[0] !== "tree") {
    throw invalidIdentity("GitHub 地址包含无法识别的路径", { input });
  }

  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Resolves symlinks, requires a readable directory, and requires it to be the
 * root of a Git work tree. The returned identity uses the realpath so two
 * spellings of the same directory can never produce two repos.
 */
export function localIdentity(canonicalRoot: string): RepoIdentity {
  if (typeof canonicalRoot !== "string" || canonicalRoot.trim() === "") {
    throw new LearningError("invalid_path", "路径不存在或不可读", {
      path: canonicalRoot,
      reason: "invalid_path",
    });
  }
  if (!path.isAbsolute(canonicalRoot)) {
    throw invalidIdentity("本地项目必须提供绝对路径", { path: canonicalRoot });
  }

  let real: string;
  try {
    real = fs.realpathSync.native(canonicalRoot);
  } catch {
    throw new LearningError("invalid_path", "路径不存在或不可读", {
      path: canonicalRoot,
      reason: "invalid_path",
    });
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(real);
  } catch {
    throw new LearningError("invalid_path", "路径不存在或不可读", {
      path: canonicalRoot,
      reason: "invalid_path",
    });
  }
  if (!stats.isDirectory()) {
    throw new LearningError("invalid_path", "路径不是目录", {
      path: canonicalRoot,
      reason: "invalid_path",
    });
  }

  try {
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new LearningError("invalid_path", "路径不可读", {
      path: canonicalRoot,
      reason: "invalid_path",
    });
  }

  const probe = gitSync(real, ["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0) {
    // A `.git` entry that Git cannot read is a corrupt repository, not a
    // directory that never was one; AC-PRJ-15 requires distinct codes.
    if (fs.existsSync(path.join(real, ".git"))) {
      throw new LearningError("object_unavailable", "Git 仓库无法读取", {
        path: real,
      });
    }
    throw invalidIdentity("该目录不是 Git 仓库", {
      path: real,
      reason: "not_git_repo",
    });
  }

  const top = probe.stdout.trim();
  let topReal = top;
  try {
    topReal = fs.realpathSync.native(top);
  } catch {
    // fall back to Git's answer
  }
  if (topReal !== real) {
    throw invalidIdentity("请选择 Git 仓库根目录", {
      path: real,
      reason: "not_git_repo",
    });
  }

  return `${LOCAL_PREFIX}${real}`;
}
