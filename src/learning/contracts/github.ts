import type { CursorJson } from "./cursor.js";
import type { ProjectId } from "./ids.js";

export interface CommitMeta {
  sha: string;
  parents: string[];
  message: string;
  authoredAt: string;
  committedAt: string;
}

export interface PullRequestMeta {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseHeadSha: string;
  updatedAt: string;
  createdAt: string;
  // NOTE: no mergeBaseSha — the merge base is computed locally from the mirror,
  // never read from a GitHub response (AC-UPD-22).
}

export interface GithubPage<T> {
  items: T[];
  nextPage: number | null;
  etag?: string;
}

export interface GithubClient {
  defaultBranch(ownerRepo: string): Promise<string>;
  commitsSince(
    ownerRepo: string,
    branch: string,
    sinceIso: string,
    opts: { page: number; perPage: number },
  ): Promise<GithubPage<CommitMeta>>;
  pullRequests(
    ownerRepo: string,
    opts: {
      state: "all";
      sort: "updated";
      direction: "desc";
      page: number;
      perPage: number;
    },
  ): Promise<GithubPage<PullRequestMeta>>;
  pullRequest(ownerRepo: string, number: number): Promise<PullRequestMeta>;
  rateLimit(): Promise<{ remaining: number; resetAt: string } | null>;
}

export const GITHUB_ALLOWED_METHODS: readonly ["GET"] = ["GET"];

export interface DiscoveryOptions {
  now: Date;
  overlapMs: number;
  perPage: number;
  maxPages: number;
}

export interface DiscoveryResult {
  discovered: number;
  enqueued: number;
  gaps: number;
  branchSwitch: boolean;
  nextDiscoveryCursor: CursorJson;
}

export interface DiscoveryService {
  tickDefaultBranch(
    projectId: ProjectId,
    opts: DiscoveryOptions,
  ): Promise<DiscoveryResult>;
  tickPullRequests(
    projectId: ProjectId,
    opts: DiscoveryOptions,
  ): Promise<DiscoveryResult>;
}
