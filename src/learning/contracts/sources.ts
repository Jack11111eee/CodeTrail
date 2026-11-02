import type { SourceStatus } from "./errors.js";
import type { GenerationId, RepoId, SourceId } from "./ids.js";
import { sha256Hex } from "./ids.js";

export type SourceKind = "repo" | "external" | "teaching_example";

export interface RepoSourceRef {
  sourceId: SourceId;
  kind: "repo";
  generationId: GenerationId;
  repoId: RepoId;
  /** 40-hex; the generation's own commit, or — for a comparison generation — the base-side commit. */
  commitSha: string;
  /** Repo-relative POSIX path, no leading "/". */
  path: string;
  /** 1-based, inclusive; null = whole file. */
  lines: { start: number; end: number } | null;
  /** "sha256:" + hex of the exact slice bytes (UTF-8). */
  contentHash: string;
}

export interface ExternalSourceRef {
  sourceId: SourceId;
  kind: "external";
  canonicalUrl: string;
  /** "v2.4.0" | ISO-8601 retrieval timestamp. */
  versionOrRetrievedAt: string;
  /** Heading / section / page anchor inside the document. */
  locator: string;
  contentHash: string;
  title: string;
}

export interface TeachingExampleRef {
  sourceId: SourceId;
  kind: "teaching_example";
  exampleId: string;
  /** Must contain "示例" in zh output. */
  label: string;
}

export type SourceRef = RepoSourceRef | ExternalSourceRef | TeachingExampleRef;

/** A source that could not be resolved. Never carries invented metadata. */
export interface SourceGap {
  kind: SourceKind;
  status: Extract<SourceStatus, "source_missing" | "source_removed">;
  /** E.g. "attention mechanism background". */
  subject: string;
  reason: string;
}

/** "sha256:" + lowercase hex of the UTF-8 bytes of `text`. */
export function sliceHash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

/** Split on "\n". Index `n` is line `n + 1`, so callers use 1-based line numbers. */
export function linesOf(text: string): string[] {
  return text.split("\n");
}

/** 1-based inclusive slice of `fileText`; out-of-range bounds are clamped. */
export function sliceLines(
  fileText: string,
  lines: { start: number; end: number },
): string {
  const all = linesOf(fileText);
  const start = Math.max(1, Math.trunc(lines.start));
  const end = Math.min(all.length, Math.trunc(lines.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "";
  }
  return all.slice(start - 1, end).join("\n");
}
