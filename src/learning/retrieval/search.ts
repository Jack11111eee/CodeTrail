/**
 * Generation-bound retrieval (architecture §10.3, AC-RET-03/04/05).
 *
 * The order is fixed: alias expansion, then the upstream FTS5 wiki search,
 * then — only when fewer than two wiki hits came back — a source search bounded
 * to the snapshot worktree. Every hit carries the full `Binding`, so a result
 * from another generation cannot be mistaken for this one; a context that does
 * not match the requested binding fails with `version_mismatch` instead.
 *
 * `Binding`, `RetrievalHit`, `Retriever` and `IndexCache` are declared in
 * `contracts/ports.ts` (§3.13) and only re-exported here (P0-A).
 */

import { LearningError } from "../contracts/index.js";
import type {
  Binding,
  GenerationId,
  IndexCache,
  NormalizedScope,
  PublishedWikiRef,
  RetrievalHit,
  Retriever,
  SnapshotReader,
  SourceSearcher,
  UpstreamRetrievalPort,
} from "../contracts/index.js";
import { expandQuery } from "../qa/query-expand.js";
import type { ExpandedQuery } from "../qa/query-expand.js";

export type {
  Binding,
  IndexCache,
  RetrievalHit,
  Retriever,
  SourceSearcher,
} from "../contracts/index.js";

/** §20: `searchWiki` may ask for at most five ranked sections. */
const WIKI_LIMIT_CAP = 5;
/** Below this many wiki hits the snapshot source keeps the search useful. */
export const FALLBACK_HIT_THRESHOLD = 2;
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 20;
const DEFAULT_CACHE_ENTRIES = 256;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * The generation-bound read surfaces a search needs. The composition root
 * injects the resolver; `retrieval/` never builds a path or reads the disk
 * itself.
 */
export interface RetrievalContext {
  /** `null` for a comparison generation, which has no wiki. */
  wiki: PublishedWikiRef | null;
  snapshot: SnapshotReader;
  scope: NormalizedScope;
  /** Present only for a comparison binding: the base commit's reader. */
  baseSnapshot?: SnapshotReader | null;
}

export type RetrieverContextResolver = (
  binding: Binding,
) => RetrievalContext | Promise<RetrievalContext>;

export interface RetrieverDeps {
  upstream: UpstreamRetrievalPort;
  source: SourceSearcher;
  /** Defaults to a fresh `createIndexCache()`. */
  cache?: IndexCache;
  /**
   * Supplies the sealed knowledge dir and the commit-bound snapshot. Required
   * for a real search; omitting it makes `search` fail closed with
   * `internal_error` rather than silently returning unbound content.
   */
  resolve?: RetrieverContextResolver;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function cloneBinding(binding: Binding): Binding {
  return { ...binding };
}

/** `undefined`, `null` and `""` all mean "not a comparison". */
function isComparison(binding: Binding): boolean {
  return (
    binding.comparisonBaseSha !== undefined &&
    binding.comparisonBaseSha !== null &&
    binding.comparisonBaseSha !== ""
  );
}

function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.generationId === right.generationId &&
    left.repoId === right.repoId &&
    left.commitSha === right.commitSha &&
    (left.comparisonBaseSha ?? null) === (right.comparisonBaseSha ?? null)
  );
}

function versionMismatch(
  message: string,
  details: Record<string, unknown>,
): LearningError {
  return new LearningError("version_mismatch", message, details);
}

function assertBindingEqual(expected: Binding, actual: Binding): void {
  if (!sameBinding(expected, actual)) {
    throw versionMismatch("检索结果的版本与请求不一致", {
      expected: cloneBinding(expected),
      actual: cloneBinding(actual),
    });
  }
}

function assertSnapshotBound(
  binding: Binding,
  snapshot: SnapshotReader,
  commitSha: string,
): void {
  if (snapshot.repoId !== binding.repoId || snapshot.commitSha !== commitSha) {
    throw versionMismatch("快照不属于该检索版本", {
      repoId: binding.repoId,
      expectedCommitSha: commitSha,
      snapshot: { repoId: snapshot.repoId, commitSha: snapshot.commitSha },
    });
  }
}

function assertWikiBound(binding: Binding, wiki: PublishedWikiRef): void {
  if (
    wiki.generationId !== binding.generationId ||
    wiki.commitSha !== binding.commitSha
  ) {
    throw versionMismatch("知识目录不属于该生成版本", {
      generationId: binding.generationId,
      expectedCommitSha: binding.commitSha,
      wiki: { generationId: wiki.generationId, commitSha: wiki.commitSha },
    });
  }
}

function assertContextBound(
  binding: Binding,
  context: RetrievalContext,
): void {
  assertSnapshotBound(binding, context.snapshot, binding.commitSha);
  if (context.wiki !== null) {
    assertWikiBound(binding, context.wiki);
  }
  if (isComparison(binding)) {
    const baseCommitSha = binding.comparisonBaseSha;
    if (baseCommitSha === undefined || baseCommitSha === null) return;
    const baseSnapshot = context.baseSnapshot ?? null;
    if (baseSnapshot === null) {
      throw versionMismatch("对比版本缺少基线快照", {
        generationId: binding.generationId,
        comparisonBaseSha: baseCommitSha,
      });
    }
    assertSnapshotBound(binding, baseSnapshot, baseCommitSha);
  }
}

interface CachedHits {
  binding: Binding;
  hits: RetrievalHit[];
}

function isCachedHits(value: unknown): value is CachedHits {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CachedHits>;
  return (
    typeof candidate.binding === "object" &&
    candidate.binding !== null &&
    Array.isArray(candidate.hits)
  );
}

function cloneHit(hit: RetrievalHit): RetrievalHit {
  const copy: RetrievalHit = {
    kind: hit.kind,
    binding: cloneBinding(hit.binding),
    preview: hit.preview,
  };
  if (hit.page !== undefined) copy.page = hit.page;
  if (hit.anchor !== undefined) copy.anchor = hit.anchor;
  if (hit.path !== undefined) copy.path = hit.path;
  if (hit.lines !== undefined) {
    copy.lines = { start: hit.lines.start, end: hit.lines.end };
  }
  if (hit.score !== undefined) copy.score = hit.score;
  return copy;
}

function cacheKeyOf(
  expanded: ExpandedQuery,
  limit: number,
  hints: readonly string[],
): string {
  return JSON.stringify(["v1", expanded.terms, limit, hints]);
}

function assertAllBound(binding: Binding, hits: readonly RetrievalHit[]): void {
  for (const hit of hits) {
    assertBindingEqual(binding, hit.binding);
  }
}

async function resolveContext(
  deps: RetrieverDeps,
  binding: Binding,
): Promise<RetrievalContext> {
  if (deps.resolve === undefined) {
    throw new LearningError(
      "internal_error",
      "检索器缺少生成版本上下文解析器",
      { generationId: binding.generationId },
    );
  }
  return await deps.resolve(binding);
}

interface SourceHit {
  path: string;
  lines: { start: number; end: number };
  preview: string;
}

interface SourceGroup {
  commitOrder: number;
  path: string;
  hits: SourceHit[];
}

/**
 * Searches one snapshot, or both commits of a comparison. Hits are merged by
 * descending hit count, then commit order (head before base), then path.
 */
async function searchSource(
  deps: RetrieverDeps,
  binding: Binding,
  context: RetrievalContext,
  terms: readonly string[],
  limit: number,
): Promise<RetrievalHit[]> {
  const snapshots: { order: number; snapshot: SnapshotReader }[] = [
    { order: 0, snapshot: context.snapshot },
  ];
  if (isComparison(binding)) {
    if (context.baseSnapshot !== undefined && context.baseSnapshot !== null) {
      snapshots.push({ order: 1, snapshot: context.baseSnapshot });
    }
  }

  const groups: SourceGroup[] = [];
  for (const entry of snapshots) {
    // Commit order is the call order the architecture fixes: head, then base.
    const hits = await deps.source.search(
      entry.snapshot,
      context.scope,
      [...terms],
      { limit },
    );
    const byPath = new Map<string, SourceHit[]>();
    for (const hit of hits) {
      const bucket = byPath.get(hit.path);
      if (bucket === undefined) {
        byPath.set(hit.path, [hit]);
      } else {
        bucket.push(hit);
      }
    }
    for (const [hitPath, fileHits] of byPath) {
      groups.push({ commitOrder: entry.order, path: hitPath, hits: fileHits });
    }
  }

  groups.sort(
    (left, right) =>
      right.hits.length - left.hits.length ||
      left.commitOrder - right.commitOrder ||
      left.path.localeCompare(right.path),
  );

  const result: RetrievalHit[] = [];
  for (const group of groups) {
    for (const hit of group.hits) {
      if (result.length >= limit) return result;
      result.push({
        kind: "source",
        binding: cloneBinding(binding),
        path: hit.path,
        lines: { start: hit.lines.start, end: hit.lines.end },
        preview: hit.preview,
      });
    }
  }
  return result;
}

export function createRetriever(deps: RetrieverDeps): Retriever {
  const cache = deps.cache ?? createIndexCache();

  return {
    async search(
      binding: Binding,
      query: string,
      opts?: { limit?: number; hints?: string[] },
    ): Promise<RetrievalHit[]> {
      const limit = clamp(
        opts?.limit ?? DEFAULT_RESULT_LIMIT,
        1,
        MAX_RESULT_LIMIT,
      );
      const hints = [...(opts?.hints ?? [])];
      const expanded = expandQuery(query);
      if (expanded.terms.length === 0) return [];

      const key = cacheKeyOf(expanded, limit, hints);
      const cached = cache.get(binding.generationId, key);
      if (isCachedHits(cached) && sameBinding(cached.binding, binding)) {
        const hits = cached.hits.slice(0, limit).map(cloneHit);
        assertAllBound(binding, hits);
        return hits;
      }

      const context = await resolveContext(deps, binding);
      assertContextBound(binding, context);

      const wikiHits =
        context.wiki === null
          ? []
          : await deps.upstream.search(
              context.wiki,
              expanded.terms.join(" "),
              hints.length === 0 ? undefined : hints,
              Math.min(limit, WIKI_LIMIT_CAP),
            );

      const hits: RetrievalHit[] = wikiHits.map((hit) => ({
        kind: "wiki",
        binding: cloneBinding(binding),
        page: hit.page,
        anchor: hit.anchor,
        preview: hit.preview,
      }));

      if (wikiHits.length < FALLBACK_HIT_THRESHOLD) {
        hits.push(
          ...(await searchSource(deps, binding, context, expanded.terms, limit)),
        );
      }

      const bounded = hits.slice(0, limit);
      assertAllBound(binding, bounded);
      cache.set(
        binding.generationId,
        key,
        { binding: cloneBinding(binding), hits: bounded.map(cloneHit) },
        CACHE_TTL_MS,
      );
      return bounded;
    },
  };
}

interface CacheEntry {
  value: unknown;
  /** `null` means "no TTL". */
  expiresAt: number | null;
}

/**
 * Per-generation LRU cache for wiki search results.
 *
 * The generation id is the first key, so an entry written for one generation
 * can never be read for another. Entries are evicted least-recently-used when
 * `maxEntries` is exceeded; `ttlMs` is optional per entry.
 */
export function createIndexCache(
  maxEntries = DEFAULT_CACHE_ENTRIES,
): IndexCache {
  const capacity = Math.max(1, Math.trunc(maxEntries));
  const generations = new Map<
    GenerationId,
    Map<string, CacheEntry>
  >();
  let size = 0;

  function expired(entry: CacheEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  function drop(map: Map<string, CacheEntry>, key: string): void {
    if (map.delete(key)) size -= 1;
  }

  function evictIfNeeded(): void {
    while (size > capacity) {
      let removed = false;
      for (const [generationId, map] of generations) {
        const oldest = map.keys().next();
        if (oldest.done === true) {
          generations.delete(generationId);
          continue;
        }
        drop(map, oldest.value);
        if (map.size === 0) generations.delete(generationId);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  return {
    get(generationId: GenerationId, key: string): unknown {
      const map = generations.get(generationId);
      if (map === undefined) return null;
      const entry = map.get(key);
      if (entry === undefined) return null;
      if (expired(entry)) {
        drop(map, key);
        if (map.size === 0) generations.delete(generationId);
        return null;
      }
      // Refresh LRU position.
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },

    set(
      generationId: GenerationId,
      key: string,
      value: unknown,
      ttlMs?: number,
    ): void {
      let map = generations.get(generationId);
      if (map === undefined) {
        map = new Map<string, CacheEntry>();
        generations.set(generationId, map);
      }
      if (map.has(key)) {
        map.delete(key);
        size -= 1;
      }
      map.set(key, {
        value,
        expiresAt:
          ttlMs === undefined ? null : Date.now() + Math.max(0, ttlMs),
      });
      size += 1;
      evictIfNeeded();
    },

    clear(generationId?: GenerationId): void {
      if (generationId === undefined) {
        generations.clear();
        size = 0;
        return;
      }
      const map = generations.get(generationId);
      if (map !== undefined) {
        size -= map.size;
        generations.delete(generationId);
      }
    },
  };
}
