/**
 * Snapshot-only source search (architecture §10.4, AC-RET-04, AC-SEC-11).
 *
 * This is the fallback the retriever runs when the wiki yields fewer than two
 * hits. It only ever sees the `SnapshotReader` it is handed: files come from
 * `snapshot.list(scope)` (already filtered for secrets, binaries and large
 * files) and bytes from `snapshot.read()`, which applies `assertReadable` with
 * the worktree root. There is no path construction and no `fs` access here.
 *
 * Bounds: at most two hits per file and twenty distinct files. Each hit is a
 * single line range plus a short preview, so the caller can render evidence
 * without reading the file again.
 *
 * `SourceSearcher` is declared in `contracts/ports.ts` (§3.13) and re-exported
 * here (P0-A).
 */

import type {
  NormalizedScope,
  SnapshotReader,
  SourceSearcher,
} from "../contracts/index.js";

export type { SourceSearcher } from "../contracts/index.js";

const MAX_FILES = 20;
const MAX_HITS_PER_FILE = 2;
const DEFAULT_LIMIT = 20;
const MAX_PREVIEW_CHARS = 200;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function previewOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_PREVIEW_CHARS
    ? `${trimmed.slice(0, MAX_PREVIEW_CHARS - 1)}…`
    : trimmed;
}

function isBinary(text: string): boolean {
  return text.includes("\u0000");
}

/**
 * Case-insensitive literal search for `terms`. A line counts once even when
 * several terms match it; results are grouped per file (descending match
 * count, then path) so the retriever can merge two commits deterministically.
 */
export function createSourceSearcher(): SourceSearcher {
  return {
    async search(
      snapshot: SnapshotReader,
      scope: NormalizedScope,
      terms: string[],
      opts?: { limit?: number },
    ): Promise<
      { path: string; lines: { start: number; end: number }; preview: string }[]
    > {
      const needles = terms
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term !== "");
      if (needles.length === 0) return [];

      const limit = clamp(
        opts?.limit ?? DEFAULT_LIMIT,
        1,
        MAX_FILES * MAX_HITS_PER_FILE,
      );
      const files = await snapshot.list(scope);

      const perFile: {
        path: string;
        matchCount: number;
        hits: {
          path: string;
          lines: { start: number; end: number };
          preview: string;
        }[];
      }[] = [];

      for (const file of files) {
        if (perFile.length >= MAX_FILES) break;
        let text: string;
        try {
          text = await snapshot.read(file.path);
        } catch {
          // A listed file that cannot be decoded is simply not evidence.
          continue;
        }
        if (isBinary(text)) continue;

        const lines = text.split(/\r?\n/u);
        const hits: (typeof perFile)[number]["hits"] = [];
        let matchCount = 0;
        for (const [index, line] of lines.entries()) {
          const lowered = line.toLowerCase();
          let matches = 0;
          for (const needle of needles) {
            if (lowered.includes(needle)) matches += 1;
          }
          if (matches === 0) continue;
          matchCount += matches;
          if (hits.length >= MAX_HITS_PER_FILE) continue;
          hits.push({
            path: file.path,
            lines: { start: index + 1, end: index + 1 },
            preview: previewOf(line),
          });
        }
        if (hits.length > 0) {
          perFile.push({ path: file.path, matchCount, hits });
        }
      }

      perFile.sort(
        (left, right) =>
          right.matchCount - left.matchCount ||
          left.path.localeCompare(right.path),
      );

      const result: {
        path: string;
        lines: { start: number; end: number };
        preview: string;
      }[] = [];
      for (const file of perFile) {
        for (const hit of file.hits) {
          if (result.length >= limit) return result;
          result.push(hit);
        }
      }
      return result;
    },
  };
}
