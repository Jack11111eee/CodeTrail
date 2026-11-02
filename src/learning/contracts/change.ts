import type { PullRequestMeta } from "./github.js";
import type { ChangeEventId } from "./ids.js";
import type { LinkRelation } from "./store.js";

export type StreamKind = "default_branch" | "pull_request" | "comparison";

export type ChangeEventKind =
  | "baseline"
  | "commit"
  | "merge_commit"
  | "pull_request"
  | "history_gap"
  | "branch_switch"
  | "comparison";

export type ChangeEventState =
  | "discovered"
  | "queued"
  | "analyzing"
  | "published"
  | "failed"
  | "waiting"
  | "cancelled"
  | "gap";

export type Significance = "full" | "short";

export interface PullRequestPayload {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  headSha: string;
  baseHeadSha: string;
  mergeBaseSha: string;
  updatedAt: string;
  branch: string;
  baseBranch: string;
}

export interface CommitPayload {
  firstParent: string | null;
  /** Branch commits brought in by a merge, never separate events. */
  associatedCommits: string[];
}

export interface ChangeEventPayload {
  commit?: CommitPayload;
  pr?: PullRequestPayload;
  gapReason?: "history_gap" | "branch_switch";
  fromBranch?: string;
  toBranch?: string;
  comparison?: { baseSha: string; headSha: string };
  /** PR → default-branch linkage (§12.7). Only present on pull_request events. */
  linkage?: {
    status: "linked" | "unlinked";
    relation?: LinkRelation;
    linkedEventId?: ChangeEventId;
    fingerprintPr?: string;
    fingerprintMain?: string;
  };
}

/**
 * Diff shape. Declared here (not in `updates/`) because
 * `BuildChangeLessonInput` and `BuildComparisonLessonInput` take it.
 */
export interface DiffEntry {
  path: string;
  status: "A" | "M" | "D" | "R";
  oldPath?: string;
}

export interface DiffResult {
  entries: DiffEntry[];
  /** True ⇒ maxFiles reached. */
  truncated: boolean;
  /** Paths whose objects were unavailable. */
  gaps: string[];
}

/**
 * The ONE bridge from the GitHub wire shape (`PullRequestMeta`) to the stored
 * payload above. Pure and total; `mergeBaseSha` is always computed locally from
 * the mirror, never taken from a GitHub response (AC-UPD-22).
 */
export function toPullRequestPayload(
  m: PullRequestMeta,
  mergeBaseSha: string,
): PullRequestPayload {
  return {
    number: m.number,
    state: m.state,
    merged: m.merged,
    title: m.title,
    headSha: m.headSha,
    baseHeadSha: m.baseHeadSha,
    mergeBaseSha,
    updatedAt: m.updatedAt,
    branch: m.headRef,
    baseBranch: m.baseRef,
  };
}
