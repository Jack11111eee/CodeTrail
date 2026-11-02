import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Fake GitHub server (PRD §15.2 item 2, architecture §17.2).
 *
 * Serves the read-only surface the change-following suite needs:
 * `Link` paging, `state=all&sort=updated&direction=desc`, `X-RateLimit-*`,
 * `Retry-After`, injectable 429/5xx and missing objects, a `/compare` file
 * list truncated at GitHub's 300-file cap, and a token gate for AC-PRJ-05.
 *
 * Every request is recorded as `{ method, path }` — including the ones that
 * fail — so AC-UPD-25 can assert that no write method was ever issued.
 */

export const COMPARE_FILE_CAP = 300;

export interface FakeGithubOptions {
  /** `owner/repo`, e.g. `acme/widgets`. */
  ownerRepo: string;
  /** Number of PR pages to generate. */
  pages: number;
  /** PRs per page. */
  perPage: number;
  /** States cycled across the generated PRs; default `["open"]`. */
  states?: Array<"open" | "closed" | "merged">;
  /** Value for `X-RateLimit-Remaining` and the reset instant. */
  rateLimit?: { remaining: number; resetAt: string };
  /** Seconds sent in `Retry-After` on an injected 429. */
  retryAfter?: number;
  /** The first N requests fail (429 when `retryAfter` is set, otherwise 500). */
  failFirst?: number;
  /** Path fragments that answer 404, e.g. `"pulls/3"` or `"commits/deadbeef"`. */
  missingObjects?: string[];
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Files generated for `/compare`; the response is capped at 300. */
  compareFiles?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
}

export interface FakeGithub {
  baseUrl: string;
  requests: RecordedRequest[];
  pushCommit(sha: string): void;
  forcePush(branch: string, sha: string): void;
  renameDefaultBranch(name: string): void;
  close(): Promise<void>;
}

interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  updated_at: string;
  created_at: string;
  title: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

interface RepoState {
  ownerRepo: string;
  defaultBranch: string;
  branches: Map<string, string>;
  commits: Array<{ sha: string; message: string; date: string }>;
  pullRequests: PullRequest[];
}

const BASE_INSTANT = Date.UTC(2024, 5, 1, 0, 0, 0);

function iso(offsetMinutes: number): string {
  return new Date(BASE_INSTANT - offsetMinutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z");
}

function deterministicSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function buildPullRequests(
  options: FakeGithubOptions,
  baseUrl: string,
): PullRequest[] {
  const states = options.states ?? ["open"];
  const total = options.pages * options.perPage;
  const pullRequests: PullRequest[] = [];
  for (let index = 1; index <= total; index += 1) {
    const declared = states[(index - 1) % states.length];
    const updated = iso(index);
    pullRequests.push({
      number: index,
      state: declared === "open" ? "open" : "closed",
      merged_at: declared === "merged" ? updated : null,
      updated_at: updated,
      created_at: iso(index + 1),
      title: `Pull request ${index}`,
      html_url: `${baseUrl}/${options.ownerRepo}/pull/${index}`,
      head: { ref: `feature-${index}`, sha: deterministicSha(`head-${index}`) },
      base: { ref: "main", sha: deterministicSha(`base-${index}`) },
    });
  }
  return pullRequests;
}

function buildCompareFiles(count: number): Array<Record<string, unknown>> {
  const files: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const filename = `src/file-${String(index).padStart(4, "0")}.ts`;
    files.push({
      filename,
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      sha: deterministicSha(filename),
    });
  }
  return files;
}

function json(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | number> = {},
): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function rateLimitHeaders(
  options: FakeGithubOptions,
): Record<string, string | number> {
  const remaining = options.rateLimit?.remaining ?? 4999;
  const resetAt = options.rateLimit?.resetAt ?? iso(0);
  return {
    "X-RateLimit-Limit": 5000,
    "X-RateLimit-Remaining": remaining,
    "X-RateLimit-Used": 5000 - remaining,
    "X-RateLimit-Reset": resetAt,
    "X-RateLimit-Resource": "core",
  };
}

function linkHeader(
  baseUrl: string,
  pathname: string,
  params: URLSearchParams,
  page: number,
  lastPage: number,
): string | null {
  const links: string[] = [];
  const link = (target: number, rel: string): void => {
    const next = new URLSearchParams(params);
    next.set("page", String(target));
    links.push(`<${baseUrl}${pathname}?${next.toString()}>; rel="${rel}"`);
  };
  if (page > 1) {
    link(1, "first");
    link(page - 1, "prev");
  }
  if (page < lastPage) {
    link(page + 1, "next");
    link(lastPage, "last");
  }
  return links.length === 0 ? null : links.join(", ");
}

function matchesMissing(pathname: string, missingObjects: string[]): boolean {
  return missingObjects.some(
    (entry) => entry !== "" && pathname.includes(entry),
  );
}

function sortPullRequests(
  pullRequests: PullRequest[],
  params: URLSearchParams,
): PullRequest[] {
  const state = params.get("state") ?? "open";
  const filtered = pullRequests.filter((pr) => {
    if (state === "all") return true;
    if (state === "open") return pr.state === "open";
    if (state === "closed") return pr.state === "closed";
    return true;
  });

  const sort = params.get("sort") ?? "updated";
  const direction = params.get("direction") ?? "desc";
  const sorted = [...filtered].sort((left, right) => {
    if (sort === "created") {
      return left.created_at.localeCompare(right.created_at);
    }
    if (sort === "updated") {
      return left.updated_at.localeCompare(right.updated_at);
    }
    return left.number - right.number;
  });
  return direction === "asc" ? sorted : sorted.reverse();
}

/** Starts the fake server on an ephemeral loopback port. */
export async function startFakeGithub(
  options: FakeGithubOptions,
): Promise<FakeGithub> {
  const [owner, repo] = options.ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`ownerRepo must be "owner/repo", got ${options.ownerRepo}`);
  }
  if (options.pages < 1 || options.perPage < 1) {
    throw new Error("pages and perPage must be >= 1");
  }

  const requests: RecordedRequest[] = [];
  let baseUrl = "http://127.0.0.1";
  const state: RepoState = {
    ownerRepo: options.ownerRepo,
    defaultBranch: "main",
    branches: new Map<string, string>([
      ["main", deterministicSha("main-head")],
      ["feature-1", deterministicSha("head-1")],
    ]),
    commits: [
      {
        sha: deterministicSha("main-head"),
        message: "base commit",
        date: iso(120),
      },
    ],
    pullRequests: buildPullRequests(options, baseUrl),
  };

  let failuresRemaining = options.failFirst ?? 0;
  const missingObjects = options.missingObjects ?? [];
  const compareFiles = buildCompareFiles(
    options.compareFiles ?? COMPARE_FILE_CAP + 20,
  );

  const server = http.createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", baseUrl);
    const pathname = url.pathname;
    requests.push({ method, path: `${pathname}${url.search}` });

    const baseHeaders = rateLimitHeaders(options);

    if (options.token !== undefined) {
      const authorization = request.headers.authorization;
      if (authorization !== `Bearer ${options.token}`) {
        json(response, 401, { message: "Bad credentials" }, baseHeaders);
        return;
      }
    }

    if (matchesMissing(pathname, missingObjects)) {
      json(response, 404, { message: "Not Found" }, baseHeaders);
      return;
    }

    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      if (options.retryAfter !== undefined) {
        json(
          response,
          429,
          { message: "API rate limit exceeded" },
          { ...baseHeaders, "Retry-After": options.retryAfter },
        );
      } else {
        json(response, 500, { message: "Internal Server Error" }, baseHeaders);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      json(response, 405, { message: "Method Not Allowed" }, baseHeaders);
      return;
    }

    const repoPrefix = `/repos/${owner}/${repo}`;
    if (pathname === repoPrefix) {
      json(
        response,
        200,
        {
          full_name: state.ownerRepo,
          default_branch: state.defaultBranch,
          private: false,
        },
        baseHeaders,
      );
      return;
    }

    if (pathname === `${repoPrefix}/pulls`) {
      const params = url.searchParams;
      const perPage = Number(params.get("per_page") ?? options.perPage);
      const page = Number(params.get("page") ?? 1);
      const sorted = sortPullRequests(state.pullRequests, params);
      const lastPage = Math.max(1, Math.ceil(sorted.length / perPage));
      const start = (page - 1) * perPage;
      const slice = sorted.slice(start, start + perPage);
      const link = linkHeader(baseUrl, pathname, params, page, lastPage);
      json(response, 200, slice, {
        ...baseHeaders,
        ...(link === null ? {} : { Link: link }),
      });
      return;
    }

    const pullMatch = new RegExp(`^${repoPrefix}/pulls/(\\d+)$`, "u").exec(
      pathname,
    );
    if (pullMatch) {
      const number = Number(pullMatch[1]);
      const pull = state.pullRequests.find(
        (candidate) => candidate.number === number,
      );
      if (!pull) {
        json(response, 404, { message: "Not Found" }, baseHeaders);
        return;
      }
      json(response, 200, pull, baseHeaders);
      return;
    }

    const commentsMatch = new RegExp(
      `^${repoPrefix}/pulls/(\\d+)/comments$`,
      "u",
    ).exec(pathname);
    if (commentsMatch) {
      json(response, 200, [], baseHeaders);
      return;
    }

    if (pathname === `${repoPrefix}/commits`) {
      json(
        response,
        200,
        state.commits.map((commit) => ({
          sha: commit.sha,
          commit: { message: commit.message, author: { date: commit.date } },
        })),
        baseHeaders,
      );
      return;
    }

    const branchMatch = new RegExp(
      `^${repoPrefix}/branches/([^/]+)$`,
      "u",
    ).exec(pathname);
    if (branchMatch) {
      const name = decodeURIComponent(branchMatch[1]);
      const sha = state.branches.get(name);
      if (sha === undefined) {
        json(response, 404, { message: "Branch not found" }, baseHeaders);
        return;
      }
      json(response, 200, { name, commit: { sha } }, baseHeaders);
      return;
    }

    const compareMatch = new RegExp(`^${repoPrefix}/compare/(.+)$`, "u").exec(
      pathname,
    );
    if (compareMatch) {
      const truncated = compareFiles.length > COMPARE_FILE_CAP;
      json(
        response,
        200,
        {
          status: "ahead",
          ahead_by: compareFiles.length,
          behind_by: 0,
          total_commits: compareFiles.length,
          files: compareFiles.slice(0, COMPARE_FILE_CAP),
          truncated,
        },
        baseHeaders,
      );
      return;
    }

    if (pathname === "/rate_limit") {
      json(
        response,
        200,
        { resources: { core: { limit: 5000 } } },
        baseHeaders,
      );
      return;
    }

    json(response, 404, { message: "Not Found" }, baseHeaders);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  // Rebuild the PR objects now that the base URL (used in `html_url`) is known.
  state.pullRequests = buildPullRequests(options, baseUrl);

  return {
    baseUrl,
    requests,
    pushCommit(sha: string): void {
      state.commits.unshift({
        sha,
        message: `pushed ${sha}`,
        date: iso(0),
      });
      state.branches.set(state.defaultBranch, sha);
    },
    forcePush(branch: string, sha: string): void {
      state.branches.set(branch, sha);
      if (branch === state.defaultBranch) {
        state.commits.unshift({
          sha,
          message: `force-pushed ${branch}`,
          date: iso(0),
        });
      }
    },
    renameDefaultBranch(name: string): void {
      const head =
        state.branches.get(state.defaultBranch) ??
        deterministicSha("main-head");
      state.branches.delete(state.defaultBranch);
      state.defaultBranch = name;
      state.branches.set(name, head);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
