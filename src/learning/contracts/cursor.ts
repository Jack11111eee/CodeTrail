import type { StreamKind } from "./change.js";
import type { RepoId } from "./ids.js";

export type CursorKind = "discovery" | "published";

export interface CursorJson {
  v: 1;
  streamKind: StreamKind;
  // default_branch stream
  /** Last default-branch head fully discovered. */
  headSha: string | null;
  /** Default branch name observed at headSha. */
  branch: string | null;
  // pull_request stream
  /** Watermark: max PR updated_at fully consumed. */
  updatedAt: string | null;
  /** Resume page inside an open window; null = window closed. */
  page: number | null;
  // comparison stream
  baseSha: string | null;
  // bookkeeping (never used for correctness decisions other than gap detection)
  /** Head of the last history_gap / branch_switch event. */
  lastGapSha: string | null;
  lastGapAt: string | null;
  lastPollAt: string | null;
}

export interface CursorUpdate {
  repoId: RepoId;
  streamId: string;
  kind: CursorKind;
  cursor: CursorJson;
  /**
   * Compare-and-swap guard: rejected if the stored cursor's (headSha, updatedAt)
   * differ. This is what makes "no second writer advances a cursor" true.
   */
  expectedPrevious: { headSha: string | null; updatedAt: string | null } | null;
}

export const CURSOR_VERSION = 1;

/** Overlap window applied by `windowStart` (PRD §10). */
const PR_OVERLAP_MS = 120_000;

export function emptyCursor(streamKind: StreamKind): CursorJson {
  return {
    v: CURSOR_VERSION,
    streamKind,
    headSha: null,
    branch: null,
    updatedAt: null,
    page: null,
    baseSha: null,
    lastGapSha: null,
    lastGapAt: null,
    lastPollAt: null,
  };
}

/**
 * Decode a persisted cursor. Returns null for anything that is not a v1 cursor
 * with the expected shape; the caller turns null into `invalid_input` /
 * `cursor_invalid` (never a silent skip).
 */
export function decodeCursor(raw: string): CursorJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const c = parsed as Record<string, unknown>;
  if (c.v !== CURSOR_VERSION) {
    return null;
  }
  if (
    c.streamKind !== "default_branch" &&
    c.streamKind !== "pull_request" &&
    c.streamKind !== "comparison"
  ) {
    return null;
  }
  const nullableString = (value: unknown): boolean =>
    value === null || typeof value === "string";
  if (
    !nullableString(c.headSha) ||
    !nullableString(c.branch) ||
    !nullableString(c.updatedAt) ||
    !nullableString(c.baseSha) ||
    !nullableString(c.lastGapSha) ||
    !nullableString(c.lastGapAt) ||
    !nullableString(c.lastPollAt)
  ) {
    return null;
  }
  if (c.page !== null && typeof c.page !== "number") {
    return null;
  }
  return parsed as CursorJson;
}

export function encodeCursor(c: CursorJson): string {
  return JSON.stringify(c);
}

/** `new Date(max(c.updatedAt ?? now - maxLookbackMs) - PR_OVERLAP_MS)`. */
export function windowStart(
  c: CursorJson,
  now: Date,
  maxLookbackMs: number,
): Date {
  const anchor =
    c.updatedAt === null
      ? now.getTime() - maxLookbackMs
      : Date.parse(c.updatedAt);
  const safeAnchor = Number.isNaN(anchor)
    ? now.getTime() - maxLookbackMs
    : anchor;
  return new Date(safeAnchor - PR_OVERLAP_MS);
}
