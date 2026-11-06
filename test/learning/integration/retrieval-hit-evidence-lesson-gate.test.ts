import { afterEach, describe, expect, it } from "vitest";

import {
  sliceHash,
  sliceLines,
  type Binding,
  type ClaimView,
  type RepoId,
  type SnapshotRecord,
} from "../../../src/learning/contracts/index.ts";
import { buildCatalog } from "../../../src/learning/evidence/catalog.ts";
import {
  createSourceReader,
  repoSourceId,
} from "../../../src/learning/evidence/registry.ts";
import {
  buildResearchLessons,
  publishVerdict,
} from "../../../src/learning/lessons/builder.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { validateEvidence } from "../../../src/learning/lessons/validate/evidence.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createSnapshotReader } from "../../../src/learning/projects/worktree.ts";
import { expandQuery } from "../../../src/learning/qa/query-expand.ts";
import { createRetriever } from "../../../src/learning/retrieval/search.ts";
import { createSourceSearcher } from "../../../src/learning/retrieval/source-search.ts";
import {
  fixtureGit,
  fixturePath,
  fixtureSha,
  requireFixtures,
} from "../helpers/git-fixture.ts";
import {
  cleanupScripts,
  fakeRegistry,
  fakeSnapshot,
  fixedClock,
  lessonEntry,
  makeContext,
  okMermaid,
  scriptDir,
  scriptedHandle,
  stubExternal,
} from "../helpers/lesson-context.ts";
import {
  defaultGeneration,
  emptyCoverage,
  researchLesson,
} from "../helpers/lesson-sample.ts";
import { contextFor } from "../retrieval/retrieval-helpers.ts";

/**
 * Integration: Chinese retrieval (issue-18) → evidence registry/catalog → lesson
 * publish gate (issue-17).
 *
 * The two merged features meet on one artefact: a `RetrievalHit`'s
 * `{path, lines}` is exactly what `SourceRegistry.registerRepo` turns into a
 * `RepoSourceRef`, which is exactly what the catalog hands the model and what
 * the evidence validator re-reads before publishing. Nothing else in either
 * suite proves those three agree on the same byte range.
 */

afterEach(cleanupScripts);

const SNAPSHOT_CACHE = [
  '"""Snapshot cache for the last-mile approval pipeline."""',
  "",
  "class SnapshotCache:",
  '    """Caches immutable approval snapshots by shipment id."""',
  "",
  "    def __init__(self) -> None:",
  "        self._entries: dict[str, dict] = {}",
  "",
  "    def evict(self, shipment_id: str) -> None:",
  '        """Drop a snapshot so the next read rebuilds current state."""',
  "        self._entries.pop(shipment_id, None)",
].join("\n");

const INDEX_TS = [
  "export function slugify(value: string): string {",
  "  return value.trim().toLowerCase();",
  "}",
].join("\n");

const PLACEHOLDER_SOURCE_ID = "s_0123456789abcdef";

function statelessUpstream(): {
  search: () => Promise<never[]>;
  readSections: () => Promise<never[]>;
  pageTitle: () => Promise<string>;
} {
  return {
    search: () => Promise.resolve([]),
    readSections: () => Promise.resolve([]),
    pageTitle: () => Promise.resolve(""),
  };
}

function remapSourceId(payload: unknown, replacement: string): unknown {
  return JSON.parse(
    JSON.stringify(payload).replaceAll(PLACEHOLDER_SOURCE_ID, replacement),
  ) as unknown;
}

describe("a retrieval hit is publishable evidence", () => {
  it("carries the same path/line bytes from source search through the catalog into the gate", async () => {
    const generation = defaultGeneration();
    const files = {
      "src/lmp/state/snapshot_cache.py": SNAPSHOT_CACHE,
      "src/index.ts": INDEX_TS,
    };
    const snapshot = fakeSnapshot(files, {
      commitSha: generation.commitSha,
      repoId: generation.repoId,
    });
    const binding: Binding = {
      generationId: generation.generationId,
      repoId: generation.repoId,
      commitSha: generation.commitSha,
    };

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => contextFor(files, { binding, snapshot }),
    });

    const hits = await retriever.search(binding, "旧快照丢了为什么会这样");
    const hit = hits
      .filter((candidate) => candidate.path === "src/lmp/state/snapshot_cache.py")
      .find((candidate) => candidate.preview.includes("SnapshotCache"));
    expect(
      hit,
      "Chinese question must reach the class declaration in the source fallback",
    ).toBeDefined();
    expect(hit!.kind).toBe("source");
    expect(hit!.lines).toBeDefined();
    expect(hit!.binding).toEqual(binding);

    // The query expansion is what made the fallback match the Python symbol.
    const expanded = expandQuery("旧快照丢了为什么会这样");
    expect(expanded.terms).toContain("SnapshotCache");
    expect(expanded.terms).toContain("evict");

    const registry = fakeRegistry();
    const ref = await registry.registerRepo({
      generationId: generation.generationId,
      repoId: generation.repoId,
      commitSha: generation.commitSha,
      path: hit!.path!,
      lines: hit!.lines!,
      snapshot,
      scope: normalizeScope(),
    });
    expect(ref.sourceId).toBe(
      repoSourceId(hit!.path!, generation.commitSha, hit!.lines!),
    );

    // The catalog must label and read the exact range the retrieval hit named.
    const catalog = await buildCatalog(
      registry.all(generation.generationId),
      createSourceReader({
        snapshotFor: () => snapshot,
        external: stubExternal(),
      }),
      8_000,
    );
    const entry = catalog.find((item) => item.sourceId === ref.sourceId);
    expect(entry, "the registered hit must appear in the model catalog").toBeDefined();
    expect(entry!.label).toBe(
      `${hit!.path}:${hit!.lines!.start}-${hit!.lines!.end}`,
    );
    expect(entry!.language).toBe("python");

    const text = await snapshot.read(hit!.path!);
    const exactSlice = sliceLines(text, hit!.lines!);
    expect(entry!.excerpt).toContain("SnapshotCache");
    expect(entry!.excerpt).toBe(exactSlice.trimEnd());
    expect(ref.contentHash).toBe(sliceHash(exactSlice));

    const payload = remapSourceId(researchLesson(), ref.sourceId);
    const parsed = parseLesson(payload);
    expect(parsed.ok, "remapped lesson must still parse").toBe(true);
    if (!parsed.ok) return;

    const ctx = makeContext({
      mode: "research",
      generation,
      registry,
      snapshot,
      coverage: emptyCoverage([hit!.path!]),
    });
    const result = await validateEvidence(parsed.lesson, ctx);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects the same citation once the snapshot bytes drift", async () => {
    const generation = defaultGeneration();
    const path = "src/lmp/state/snapshot_cache.py";
    const files = { [path]: SNAPSHOT_CACHE };
    const snapshot = fakeSnapshot(files, {
      commitSha: generation.commitSha,
      repoId: generation.repoId,
    });
    const registry = fakeRegistry();
    const ref = await registry.registerRepo({
      generationId: generation.generationId,
      repoId: generation.repoId,
      commitSha: generation.commitSha,
      path,
      lines: { start: 3, end: 3 },
      snapshot,
      scope: normalizeScope(),
    });

    const payload = remapSourceId(researchLesson(), ref.sourceId);
    const parsed = parseLesson(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const drifted = fakeSnapshot(
      { [path]: SNAPSHOT_CACHE.replace("class SnapshotCache", "class SnapshotCacheV2") },
      { commitSha: generation.commitSha, repoId: generation.repoId },
    );
    const ctx = makeContext({
      mode: "research",
      generation,
      registry,
      snapshot: drifted,
      coverage: emptyCoverage([path]),
    });

    const result = await validateEvidence(parsed.lesson, ctx);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "evidence_repo" &&
          issue.message.includes("content_hash"),
      ),
      "a drifted snapshot must fail the evidence hash, not silently publish",
    ).toBe(true);
  });
});

describe("retrieval against the real last-mile-mini snapshot", () => {
  it("finds the SnapshotCache symbol and the citation validates against the same Git object", async () => {
    requireFixtures();
    const name = "last-mile-mini";
    const worktreePath = fixturePath(name);
    const commitSha = fixtureSha(name, "HEAD");
    const generation = defaultGeneration({ commitSha });
    const repoId = generation.repoId as RepoId;

    const record: SnapshotRecord = {
      repoId,
      commitSha,
      treeHash: fixtureGit(name, ["rev-parse", `${commitSha}^{tree}`]),
      worktreePath,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };
    const snapshot = createSnapshotReader(record, normalizeScope());
    const binding: Binding = {
      generationId: generation.generationId,
      repoId,
      commitSha,
    };

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => ({
        wiki: null,
        snapshot,
        scope: normalizeScope(),
      }),
    });

    const hits = await retriever.search(binding, "旧快照丢了为什么会这样");
    // AC-RET-03: the top-3 names the SnapshotCache symbol. The snapshot file
    // itself may rank just below that on the source-only fallback, so it is
    // located in the full hit list and then carried through the gate.
    expect(
      hits
        .slice(0, 3)
        .some((candidate) => candidate.preview.includes("SnapshotCache")),
      "AC-RET-03: the top-3 must name the SnapshotCache symbol",
    ).toBe(true);

    const hit = hits.find(
      (candidate) =>
        candidate.path === "src/lmp/state/snapshot_cache.py" &&
        candidate.preview.includes("SnapshotCache"),
    );
    expect(
      hit,
      "the source fallback must reach src/lmp/state/snapshot_cache.py",
    ).toBeDefined();
    expect(hit!.binding).toEqual(binding);

    const registry = fakeRegistry();
    const ref = await registry.registerRepo({
      generationId: generation.generationId,
      repoId,
      commitSha,
      path: hit!.path!,
      lines: hit!.lines!,
      snapshot,
      scope: normalizeScope(),
    });

    const payload = remapSourceId(researchLesson(), ref.sourceId);
    const parsed = parseLesson(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const ctx = makeContext({
      mode: "research",
      generation,
      registry,
      snapshot,
      coverage: emptyCoverage([hit!.path!]),
    });
    const result = await validateEvidence(parsed.lesson, ctx);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("research builder stages the retrieval-derived claim", () => {
  it("publishes a lesson that cites exactly the source id the retrieval hit produced", async () => {
    const generation = defaultGeneration();
    const files = {
      "src/lmp/state/snapshot_cache.py": SNAPSHOT_CACHE,
      "src/index.ts": INDEX_TS,
    };
    const snapshot = fakeSnapshot(files, {
      commitSha: generation.commitSha,
      repoId: generation.repoId,
    });
    const binding: Binding = {
      generationId: generation.generationId,
      repoId: generation.repoId,
      commitSha: generation.commitSha,
    };

    const retriever = createRetriever({
      upstream: statelessUpstream(),
      source: createSourceSearcher(),
      resolve: () => contextFor(files, { binding, snapshot }),
    });
    const hits = await retriever.search(binding, "旧快照丢了为什么会这样");
    const hit = hits
      .filter((candidate) => candidate.path === "src/lmp/state/snapshot_cache.py")
      .find((candidate) => candidate.preview.includes("SnapshotCache"));
    expect(hit).toBeDefined();

    const sourceId = repoSourceId(
      hit!.path!,
      generation.commitSha,
      hit!.lines!,
    );
    const claim: ClaimView = {
      id: "c_snapshot_evict",
      statement: "SnapshotCache 声明在快照缓存模块中",
      evidence: [
        {
          resource: `repo://${hit!.path}#L${hit!.lines!.start}-L${hit!.lines!.end}`,
          version: generation.commitSha,
        },
      ],
    };

    const registry = fakeRegistry();
    const payload = remapSourceId(researchLesson(), sourceId);
    const model = scriptedHandle(scriptDir([lessonEntry(payload)]));

    const result = await buildResearchLessons(
      {
        generation,
        snapshot,
        scope: normalizeScope(),
        coverage: emptyCoverage([hit!.path!]),
        model,
        registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      {
        claims: {
          pages: () => Promise.resolve(["core/snapshot-cache.md"]),
          claimsFor: () => Promise.resolve([claim]),
          markdown: () => Promise.resolve(""),
        },
        mermaid: okMermaid(),
      },
    );

    expect(result.failures).toEqual([]);
    expect(publishVerdict(result)).toEqual({ publishable: true });
    expect(result.lessons).toHaveLength(1);

    const lesson = result.lessons[0];
    expect(lesson.evidence).toContain(sourceId);
    expect(
      registry.all(generation.generationId).map((ref) => ref.sourceId),
      "the builder must stage the source the retrieval hit named",
    ).toContain(sourceId);
  });
});
