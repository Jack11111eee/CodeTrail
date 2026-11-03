/**
 * Read-only GitHub client (architecture §12.1).
 *
 * Only `GET` exists. The wire types are declared in `contracts/github.ts`
 * (§3.16) because the fake server and this client must agree on them; they are
 * re-exported here, never redeclared. A credential is sent as a bearer token
 * and never appears in an error message or a thrown detail.
 */

import { GITHUB_ALLOWED_METHODS, LearningError } from "../contracts/index.js";
import type {
  Clock,
  CommitMeta,
  GithubClient,
  GithubCredential,
  GithubPage,
  PullRequestMeta,
} from "../contracts/index.js";

// Declared in contracts/github.ts (§3.16); re-export only.
export type { CommitMeta, PullRequestMeta, GithubPage, GithubClient };
export { GITHUB_ALLOWED_METHODS };

/** Extracts the `page` of the `rel="next"` link, or null when there is none. */
export function parseNextPage(link: string | null): number | null {
  if (link === null || link === "") return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/u.exec(part.trim());
    if (match === null) continue;
    if (match[2].trim() !== "next") continue;
    try {
      const url = new URL(match[1]);
      const page = Number(url.searchParams.get("page") ?? "");
      return Number.isInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

function assertOwnerRepo(value: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) {
    throw new LearningError("invalid_input", "GitHub 仓库标识无效", {
      value,
    });
  }
  return value;
}

interface WireCommit {
  sha?: unknown;
  parents?: unknown;
  commit?: {
    message?: unknown;
    author?: { date?: unknown };
    committer?: { date?: unknown };
  };
}

interface WirePullRequest {
  number?: unknown;
  state?: unknown;
  merged_at?: unknown;
  title?: unknown;
  head?: { ref?: unknown; sha?: unknown };
  base?: { ref?: unknown; sha?: unknown };
  updated_at?: unknown;
  created_at?: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** The single wire → `CommitMeta` mapping. */
export function toCommitMeta(value: unknown): CommitMeta {
  const wire = (value ?? {}) as WireCommit;
  const parents = Array.isArray(wire.parents)
    ? wire.parents
        .map((parent) =>
          typeof parent === "string"
            ? parent
            : asString((parent as { sha?: unknown })?.sha),
        )
        .filter((sha) => sha !== "")
    : [];
  return {
    sha: asString(wire.sha),
    parents,
    message: asString(wire.commit?.message),
    authoredAt: asString(wire.commit?.author?.date),
    committedAt: asString(wire.commit?.committer?.date),
  };
}

/** The single wire → `PullRequestMeta` mapping (no `mergeBaseSha` on purpose). */
export function toPullRequestMeta(value: unknown): PullRequestMeta {
  const wire = (value ?? {}) as WirePullRequest;
  return {
    number: typeof wire.number === "number" ? wire.number : Number(wire.number),
    state: wire.state === "closed" ? "closed" : "open",
    merged: wire.merged_at !== null && wire.merged_at !== undefined,
    title: asString(wire.title),
    headRef: asString(wire.head?.ref),
    headSha: asString(wire.head?.sha),
    baseRef: asString(wire.base?.ref),
    baseHeadSha: asString(wire.base?.sha),
    updatedAt: asString(wire.updated_at),
    createdAt: asString(wire.created_at),
  };
}

function failure(status: number, url: string, body: string): LearningError {
  const detail = { status, url };
  if (status === 401) {
    return new LearningError("github_auth_failed", "GitHub 认证失败", detail);
  }
  if (status === 403 || status === 429) {
    return new LearningError("rate_limited", "请求过于频繁", detail);
  }
  if (status === 404) {
    return new LearningError("not_found", "GitHub 资源不存在", detail);
  }
  if (status === 422) {
    return new LearningError("invalid_input", "GitHub 请求无效", {
      ...detail,
      body,
    });
  }
  return new LearningError("internal_error", "GitHub 请求失败", detail);
}

/**
 * Implements `GithubClient` (§3.16). Every call is a plain `GET`; there is no
 * post/patch/put/delete surface anywhere in this module (AC-UPD-25).
 */
export function createGithubClient(deps: {
  baseUrl: string;
  credential: GithubCredential | null;
  clock: Clock;
}): GithubClient {
  const root = deps.baseUrl.replace(/\/+$/u, "");
  void deps.clock;

  async function get(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<{ body: unknown; headers: Headers }> {
    const url = new URL(`${root}${path}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codetrail-learning",
    };
    const token = deps.credential?.token;
    if (typeof token === "string" && token !== "") {
      headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers });
    } catch (error) {
      throw new LearningError("internal_error", "无法访问 GitHub", {
        url: `${url.origin}${url.pathname}`,
        cause: (error as Error).message,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw failure(response.status, `${url.origin}${url.pathname}`, text);
    }
    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      throw new LearningError("internal_error", "GitHub 响应不是 JSON", {
        url: `${url.origin}${url.pathname}`,
      });
    }
    return { body, headers: response.headers };
  }

  return {
    async defaultBranch(ownerRepo: string): Promise<string> {
      const repo = assertOwnerRepo(ownerRepo);
      const { body } = await get(`/repos/${repo}`);
      const value = (body as { default_branch?: unknown }).default_branch;
      if (typeof value !== "string" || value === "") {
        throw new LearningError("internal_error", "GitHub 未返回默认分支", {
          repo,
        });
      }
      return value;
    },

    async commitsSince(
      ownerRepo: string,
      branch: string,
      sinceIso: string,
      opts: { page: number; perPage: number },
    ): Promise<GithubPage<CommitMeta>> {
      const repo = assertOwnerRepo(ownerRepo);
      const { body, headers } = await get(`/repos/${repo}/commits`, {
        sha: branch,
        since: sinceIso,
        page: opts.page,
        per_page: opts.perPage,
      });
      const items = Array.isArray(body) ? body.map(toCommitMeta) : [];
      return {
        items,
        nextPage: parseNextPage(headers.get("link")),
      };
    },

    async pullRequests(
      ownerRepo: string,
      opts: {
        state: "all";
        sort: "updated";
        direction: "desc";
        page: number;
        perPage: number;
      },
    ): Promise<GithubPage<PullRequestMeta>> {
      const repo = assertOwnerRepo(ownerRepo);
      const { body, headers } = await get(`/repos/${repo}/pulls`, {
        state: opts.state,
        sort: opts.sort,
        direction: opts.direction,
        page: opts.page,
        per_page: opts.perPage,
      });
      const items = Array.isArray(body) ? body.map(toPullRequestMeta) : [];
      return {
        items,
        nextPage: parseNextPage(headers.get("link")),
      };
    },

    async pullRequest(
      ownerRepo: string,
      number: number,
    ): Promise<PullRequestMeta> {
      const repo = assertOwnerRepo(ownerRepo);
      const { body } = await get(`/repos/${repo}/pulls/${number}`);
      return toPullRequestMeta(body);
    },

    async rateLimit(): Promise<{ remaining: number; resetAt: string } | null> {
      const { headers } = await get("/rate_limit");
      const remainingHeader = headers.get("x-ratelimit-remaining");
      // A missing header means "unknown", not zero: `Number("") === 0`.
      if (remainingHeader === null || remainingHeader.trim() === "") {
        return null;
      }
      const remaining = Number(remainingHeader);
      if (!Number.isFinite(remaining)) return null;
      const resetHeader = headers.get("x-ratelimit-reset");
      const reset =
        resetHeader === null || resetHeader.trim() === ""
          ? Number.NaN
          : Number(resetHeader);
      return {
        remaining,
        resetAt: Number.isFinite(reset)
          ? new Date(reset * 1000).toISOString()
          : new Date(0).toISOString(),
      };
    },
  };
}
