/**
 * Merge linkage (architecture §12.7, PRD §10).
 *
 * After a PR merges the default-branch generation is **always** built first;
 * only provably equal snapshot content (tree + merge base + scope + config)
 * suppresses a second lesson. This module is pure: no model call is ever made
 * on the reuse path, so reuse can never depend on model similarity.
 */

import {
  computeComparisonFingerprint,
  LearningError,
} from "../contracts/index.js";
import type {
  ChangeEventId,
  ComparisonFingerprintInput,
  LinkRelation,
  Repositories,
} from "../contracts/index.js";

// Declared in contracts/keys.ts (§3.7); re-export only, never redeclare.
export type { ComparisonFingerprintInput };
export { computeComparisonFingerprint };

export type LinkageReason =
  | "tree_equal"
  | "tree_differs"
  | "merge_base_differs"
  | "config_differs"
  | "not_reachable_from_default_branch";

export interface LinkageDecision {
  relation: LinkRelation; // identical_content | supplementary | unlinked_squash
  prFingerprint: string;
  mainFingerprint: string;
  reason: LinkageReason;
}

export interface LinkageService {
  /**
   * Called from inside the default-branch publish transaction, never before
   * it. Writes the PR event's `linked_event_id` and `link_relation`.
   */
  link(i: {
    prEventId: ChangeEventId;
    defaultBranchEventId: ChangeEventId;
    decision: LinkageDecision;
  }): Promise<void>;
}

export interface DecideLinkageInput {
  prHeadTreeHash: string;
  mainTreeHash: string;
  prMergeBaseSha: string | null;
  mainMergeBaseSha: string | null;
  scopeHash: string;
  configHash: string;
  /** Squash/rebase: the PR head is not an ancestor of the landed commit. */
  reachableFromDefaultBranch?: boolean;
  /** Optional split hashes; the architecture signature defaults to one hash. */
  prConfigHash?: string;
  mainConfigHash?: string;
}

/**
 * Pure decision. `identical_content` is the only relation that permits reuse;
 * every other outcome keeps both records.
 */
export function decideLinkage(i: DecideLinkageInput): LinkageDecision {
  const effectiveConfig = i.configHash;
  const prFingerprint = computeComparisonFingerprint({
    treeHash: i.prHeadTreeHash,
    mergeBaseSha: i.prMergeBaseSha,
    scopeHash: i.scopeHash,
    configHash: i.prConfigHash ?? effectiveConfig,
  });
  const mainFingerprint = computeComparisonFingerprint({
    treeHash: i.mainTreeHash,
    mergeBaseSha: i.mainMergeBaseSha,
    scopeHash: i.scopeHash,
    configHash: i.mainConfigHash ?? effectiveConfig,
  });

  if (i.reachableFromDefaultBranch === false) {
    return {
      relation: "unlinked_squash",
      prFingerprint,
      mainFingerprint,
      reason: "not_reachable_from_default_branch",
    };
  }
  if (
    i.prConfigHash !== undefined &&
    i.mainConfigHash !== undefined &&
    i.prConfigHash !== i.mainConfigHash
  ) {
    return {
      relation: "supplementary",
      prFingerprint,
      mainFingerprint,
      reason: "config_differs",
    };
  }
  if (i.prHeadTreeHash !== i.mainTreeHash) {
    return {
      relation: "supplementary",
      prFingerprint,
      mainFingerprint,
      reason: "tree_differs",
    };
  }
  if (i.prMergeBaseSha !== i.mainMergeBaseSha) {
    return {
      relation: "supplementary",
      prFingerprint,
      mainFingerprint,
      reason: "merge_base_differs",
    };
  }
  return {
    relation: "identical_content",
    prFingerprint,
    mainFingerprint,
    reason: "tree_equal",
  };
}

/**
 * Persists a linkage. The write is intentionally a thin wrapper around
 * `ChangesRepo.link`, so it can only run inside the publisher's transaction.
 */
export function createLinkageService(deps?: {
  repos: Repositories;
}): LinkageService {
  return {
    link(i): Promise<void> {
      if (deps === undefined) {
        throw new LearningError("internal_error", "链接服务缺少仓库依赖", {
          reason: "linked_event_missing",
        });
      }
      const pr = deps.repos.changes.byId(i.prEventId);
      if (pr === null) {
        throw new LearningError("internal_error", "PR 事件不存在", {
          eventId: i.prEventId,
          reason: "linked_event_missing",
        });
      }
      const defaultBranch = deps.repos.changes.byId(i.defaultBranchEventId);
      if (defaultBranch === null) {
        throw new LearningError("internal_error", "默认分支事件不存在", {
          eventId: i.defaultBranchEventId,
          reason: "linked_event_missing",
        });
      }
      deps.repos.changes.link({
        prEventId: i.prEventId,
        defaultBranchEventId: i.defaultBranchEventId,
        relation: i.decision.relation,
      });
      return Promise.resolve();
    },
  };
}
