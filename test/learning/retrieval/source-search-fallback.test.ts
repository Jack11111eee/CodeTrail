import { describe, expect, it } from "vitest";

import type {
  Binding,
  RetrievalHit,
  SnapshotReader,
  SourceSearcher,
  UpstreamRetrievalPort,
  WikiHit,
} from "../../../src/learning/contracts/index.js";
import { isReadable } from "../../../src/learning/projects/scope.js";
import {
  FALLBACK_HIT_THRESHOLD,
  createIndexCache,
  createRetriever,
} from "../../../src/learning/retrieval/search.js";
import { createSourceSearcher } from "../../../src/learning/retrieval/source-search.js";
import { BASE_SHA, DEFAULT_SCOPE, HEAD_SHA, fakeSnapshot } from "./evidence-harness.js";
import {
  contextFor,
  makeBinding,
  makeKnowledgeDir,
} from "./retrieval-helpers.js";

/**
 * AC-RET-03/04: the fixed order alias expansion → upstream FTS5 → snapshot
 * source fallback, the fallback threshold at 0/1/2 hits, and the source
 * search's snapshot-only bounds.
 */

function wikiHit(page: string): WikiHit {
  return { page, anchor: "section", title: page, preview: `preview ${page}` };
}

function upstreamReturning(
  hits: WikiHit[],
  calls: string[],
): UpstreamRetrievalPort {
  return {
    search(): Promise<WikiHit[]> {
      calls.push("upstream");
      return Promise.resolve(hits.map((hit) => ({ ...hit })));
    },
    readSections(): Promise<[]> {
      return Promise.resolve([]);
    },
    pageTitle(): Promise<string> {
      return Promise.resolve("");
    },
  };
}

function sourceReturning(
  hits: { path: string; lines: { start: number; end: number }; preview: string }[],
  calls: string[],
): SourceSearcher {
  return {
    search(): Promise<
      { path: string; lines: { start: number; end: number }; preview: string }[]
    > {
      calls.push("source");
      return Promise.resolve(hits.map((hit) => ({ ...hit })));
    },
  };
}

function retrieverWith(
  upstream: UpstreamRetrievalPort,
  source: SourceSearcher,
  binding: Binding,
  extra: Record<string, string>,
  knowledgeDir = "/tmp/codetrail-knowledge",
) {
  return createRetriever({
    upstream,
    source,
    cache: createIndexCache(),
    resolve: () => contextFor(extra, { binding, knowledgeDir }),
  });
}

describe("fixed retrieval order and fallback threshold", () => {
  it("runs alias expansion, upstream, then the source fallback at zero hits", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const retriever = retrieverWith(
      upstreamReturning([], calls),
      sourceReturning(
        [{ path: "src/lmp/state/snapshot_cache.py", lines: { start: 8, end: 8 }, preview: "SnapshotCache" }],
        calls,
      ),
      binding,
      { "src/lmp/state/snapshot_cache.py": "class SnapshotCache:\n" },
    );

    const hits = await retriever.search(binding, "旧快照丢了为什么会这样");

    expect(calls).toEqual(["upstream", "source"]);
    expect(hits.map((hit) => hit.kind)).toEqual(["source"]);
  });

  it("still falls back with exactly one wiki hit", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const retriever = retrieverWith(
      upstreamReturning([wikiHit("openwiki/a.md")], calls),
      sourceReturning(
        [{ path: "src/cache.py", lines: { start: 1, end: 1 }, preview: "SnapshotCache" }],
        calls,
      ),
      binding,
      { "src/cache.py": "SnapshotCache()\n" },
    );

    const hits = await retriever.search(binding, "旧快照");

    expect(calls).toEqual(["upstream", "source"]);
    expect(hits.map((hit) => hit.kind)).toEqual(["wiki", "source"]);
  });

  it("does not fall back at two wiki hits", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const retriever = retrieverWith(
      upstreamReturning(
        [wikiHit("openwiki/a.md"), wikiHit("openwiki/b.md")],
        calls,
      ),
      sourceReturning(
        [{ path: "src/cache.py", lines: { start: 1, end: 1 }, preview: "SnapshotCache" }],
        calls,
      ),
      binding,
      { "src/cache.py": "SnapshotCache()\n" },
    );

    const hits = await retriever.search(binding, "旧快照");

    expect(FALLBACK_HIT_THRESHOLD).toBe(2);
    expect(calls).toEqual(["upstream"]);
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.kind === "wiki")).toBe(true);
  });

  it("skips the upstream call when there is no wiki (comparison generations)", async () => {
    const calls: string[] = [];
    const binding = makeBinding({ comparisonBaseSha: BASE_SHA });
    const head = fakeSnapshot(
      { "src/cache.py": "SnapshotCache head\n" },
      { commitSha: HEAD_SHA },
    );
    const base = fakeSnapshot(
      { "src/cache.py": "SnapshotCache base\n" },
      { commitSha: BASE_SHA },
    );
    const retriever = createRetriever({
      upstream: upstreamReturning([wikiHit("openwiki/a.md")], calls),
      source: sourceReturning(
        [{ path: "src/cache.py", lines: { start: 1, end: 1 }, preview: "head" }],
        calls,
      ),
      cache: createIndexCache(),
      resolve: () => contextFor({}, { binding, snapshot: head, baseSnapshot: base }),
    });

    await retriever.search(binding, "旧快照");
    expect(calls).toEqual(["source", "source"]);
  });

  it("returns [] and touches nothing for a query with no usable term", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const retriever = retrieverWith(
      upstreamReturning([wikiHit("openwiki/a.md")], calls),
      sourceReturning([], calls),
      binding,
      {},
    );

    await expect(retriever.search(binding, "   ")).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("caps the final result count at the requested limit", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const sourceHits = Array.from({ length: 10 }, (_unused, index) => ({
      path: `src/f${index}.py`,
      lines: { start: 1, end: 1 },
      preview: "SnapshotCache",
    }));
    const retriever = retrieverWith(
      upstreamReturning([], calls),
      sourceReturning(sourceHits, calls),
      binding,
      {},
    );

    const hits = await retriever.search(binding, "旧快照", { limit: 3 });
    expect(hits).toHaveLength(3);
  });
});

describe("hits carry the requested binding", () => {
  it("binds every wiki and source hit", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const retriever = retrieverWith(
      upstreamReturning([wikiHit("openwiki/a.md")], calls),
      sourceReturning(
        [{ path: "src/cache.py", lines: { start: 3, end: 3 }, preview: "SnapshotCache" }],
        calls,
      ),
      binding,
      { "src/cache.py": "x\ny\nSnapshotCache\n" },
    );

    const hits = await retriever.search(binding, "旧快照");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.binding).toEqual(binding);
    }
  });

  it("returns only the content bound to a comparison head and base", async () => {
    const calls: string[] = [];
    const binding = makeBinding({ comparisonBaseSha: BASE_SHA });
    const head = fakeSnapshot(
      { "src/cache.py": "SnapshotCache head\n" },
      { commitSha: HEAD_SHA },
    );
    const base = fakeSnapshot(
      { "src/cache.py": "SnapshotCache base\n" },
      { commitSha: BASE_SHA },
    );
    const seen: string[] = [];
    const source: SourceSearcher = {
      search(snapshot) {
        seen.push(snapshot.commitSha);
        return Promise.resolve([
          {
            path: "src/cache.py",
            lines: { start: 1, end: 1 },
            preview: snapshot.commitSha === HEAD_SHA ? "head" : "base",
          },
        ]);
      },
    };
    const retriever = createRetriever({
      upstream: upstreamReturning([], calls),
      source,
      cache: createIndexCache(),
      resolve: () => contextFor({}, { binding, snapshot: head, baseSnapshot: base }),
    });

    const hits = await retriever.search(binding, "旧快照");

    expect(seen).toEqual([HEAD_SHA, BASE_SHA]);
    expect(hits.map((hit) => hit.preview)).toEqual(["head", "base"]);
    for (const hit of hits) {
      expect(hit.binding).toEqual(binding);
    }
  });

  it("rejects a snapshot from another commit with version_mismatch", async () => {
    const binding = makeBinding();
    const retriever = createRetriever({
      upstream: upstreamReturning([], []),
      source: sourceReturning([], []),
      cache: createIndexCache(),
      resolve: () =>
        contextFor(
          {},
          { binding, snapshot: fakeSnapshot({}, { commitSha: "c".repeat(40) }) },
        ),
    });

    await expect(retriever.search(binding, "旧快照")).rejects.toMatchObject({
      code: "version_mismatch",
    });
  });

  it("rejects a snapshot from another repo with version_mismatch", async () => {
    const binding = makeBinding();
    const retriever = createRetriever({
      upstream: upstreamReturning([], []),
      source: sourceReturning([], []),
      cache: createIndexCache(),
      resolve: () =>
        contextFor(
          {},
          {
            binding,
            snapshot: fakeSnapshot({}, { commitSha: HEAD_SHA, repoId: "r_2" }),
          },
        ),
    });

    await expect(retriever.search(binding, "旧快照")).rejects.toMatchObject({
      code: "version_mismatch",
    });
  });

  it("fails closed without a context resolver", async () => {
    const retriever = createRetriever({
      upstream: upstreamReturning([], []),
      source: sourceReturning([], []),
      cache: createIndexCache(),
    });

    await expect(
      retriever.search(makeBinding(), "旧快照"),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("createSourceSearcher", () => {
  function spiedReader(files: Record<string, string>): {
    reader: SnapshotReader;
    reads: string[];
    events: string[];
  } {
    const base = fakeSnapshot(files);
    const reads: string[] = [];
    const events: string[] = [];
    const reader: SnapshotReader = {
      ...base,
      list(scope) {
        events.push("list");
        return base.list(scope).then((entries) =>
          entries.filter((entry) => isReadable(entry.path, scope)),
        );
      },
      read(relPath) {
        events.push(`read:${relPath}`);
        reads.push(relPath);
        return base.read(relPath);
      },
      slice() {
        events.push("slice");
        return Promise.reject(new Error("source search must not slice"));
      },
    };
    return { reader, reads, events };
  }

  it("returns file paths and line ranges from the snapshot only", async () => {
    const { reader, reads, events } = spiedReader({
      "src/lmp/state/snapshot_cache.py": [
        '"""Snapshot cache."""',
        "",
        "class SnapshotCache:",
        "    def evict(self, key):",
        "        self._entries.pop(key, None)",
        "",
      ].join("\n"),
      "app/screens.py": "from lmp.state.snapshot_cache import SnapshotCache\n",
      ".env": "SnapshotCache=leak\n",
    });

    const hits = await createSourceSearcher().search(
      reader,
      DEFAULT_SCOPE,
      ["SnapshotCache", "evict"],
    );

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.lines.start).toBeGreaterThan(0);
      expect(hit.lines.end).toBeGreaterThanOrEqual(hit.lines.start);
      expect(hit.preview.length).toBeGreaterThan(0);
    }
    expect(hits[0]?.path).toBe("src/lmp/state/snapshot_cache.py");
    // Everything read was listed by the snapshot reader; the scoped-out .env
    // was never even enumerated, let alone read.
    expect(events[0]).toBe("list");
    expect(reads).not.toContain(".env");
    expect(reads).toContain("src/lmp/state/snapshot_cache.py");
    expect(events).not.toContain("slice");
  });

  it("returns at most two hits per file", async () => {
    const { reader } = spiedReader({
      "src/cache.py": Array.from(
        { length: 6 },
        (_unused, index) => `SnapshotCache line ${index}`,
      ).join("\n"),
    });

    const hits = await createSourceSearcher().search(reader, DEFAULT_SCOPE, [
      "SnapshotCache",
    ]);
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.lines.start)).toEqual([1, 2]);
  });

  it("respects the file and result bounds", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) {
      files[`src/f${String(index).padStart(2, "0")}.py`] = `SnapshotCache ${index}`;
    }
    const { reader, reads } = spiedReader(files);

    const hits = await createSourceSearcher().search(reader, DEFAULT_SCOPE, [
      "SnapshotCache",
    ]);
    const paths = new Set(hits.map((hit) => hit.path));
    expect(paths.size).toBeLessThanOrEqual(20);
    expect(reads).toHaveLength(paths.size);
  });

  it("returns [] for an empty term list without reading the snapshot", async () => {
    const { reader, events } = spiedReader({ "src/cache.py": "SnapshotCache\n" });
    const hits = await createSourceSearcher().search(reader, DEFAULT_SCOPE, []);
    expect(hits).toEqual([]);
    expect(events).toEqual([]);
  });

  it("matches case-insensitively", async () => {
    const { reader } = spiedReader({
      "src/cache.py": "class SNAPSHOTCACHE:\n    def EVICT(self): ...\n",
    });
    const hits = await createSourceSearcher().search(reader, DEFAULT_SCOPE, [
      "snapshotcache",
      "evict",
    ]);
    expect(hits.map((hit) => hit.lines.start)).toEqual([1, 2]);
  });
});

describe("retriever result shape", () => {
  it("exposes only the requested binding on a wiki hit", () => {
    const hit: RetrievalHit = {
      kind: "wiki",
      binding: makeBinding(),
      page: "openwiki/a.md",
      anchor: "a",
      preview: "text",
    };
    expect(hit.binding.commitSha).toBe(HEAD_SHA);
  });
});

// A knowledge dir is threaded through one test to keep the helper honest.
describe("knowledge ref binding", () => {
  it("rejects a knowledge dir from another generation", async () => {
    const binding = makeBinding();
    const knowledgeDir = await makeKnowledgeDir({ "a.md": "# A\n" });
    const retriever = createRetriever({
      upstream: upstreamReturning([], []),
      source: sourceReturning([], []),
      cache: createIndexCache(),
      resolve: () => ({
        ...contextFor({}, { binding }),
        wiki: {
          state: "published",
          generationId: "g_other" as typeof binding.generationId,
          commitSha: HEAD_SHA,
          knowledgeDir,
          sealedTreeHash: `sha256:${"0".repeat(64)}`,
        },
      }),
    });

    await expect(retriever.search(binding, "旧快照")).rejects.toMatchObject({
      code: "version_mismatch",
    });
  });
});
