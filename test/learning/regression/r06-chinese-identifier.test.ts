/**
 * AC-R06-01: a Chinese question and an identifier question must land on the
 * same evidence. "旧快照丢了怎么办" expands through `TERM_ALIASES`;
 * "snapshot_cache 里怎么处理淘汰" preserves the identifier. Both then reach
 * `src/lmp/state/snapshot_cache.py`, and the snapshot-source fallback returns
 * the same lines for that file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { RetrievalHit } from "../../../src/learning/contracts/index.ts";
import { expandQuery } from "../../../src/learning/qa/query-expand.ts";
import { createSourceSearcher } from "../../../src/learning/retrieval/source-search.ts";
import { DEFAULT_SCOPE, fakeSnapshot } from "../retrieval/evidence-harness.ts";
import {
  fixturePath,
  fixtureSha,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = "last-mile-mini";
const CACHE = "src/lmp/state/snapshot_cache.py";
const SCREEN = "app/screens.py";
const MOCK = "src/lmp/adapters/mock/server.py";

const CHINESE = "旧快照丢了怎么办";
const IDENTIFIER = "snapshot_cache 里怎么处理淘汰";

let files: Record<string, string> = {};
let snapshot: ReturnType<typeof fakeSnapshot>;

beforeAll(() => {
  if (!existsSync(path.join(fixturesDir(), "manifest.json"))) {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  }
  requireFixtures();
  const root = fixturePath(FIXTURE);
  files = {
    [CACHE]: readFileSync(path.join(root, CACHE), "utf8"),
    [SCREEN]: readFileSync(path.join(root, SCREEN), "utf8"),
    [MOCK]: readFileSync(path.join(root, MOCK), "utf8"),
  };
  snapshot = fakeSnapshot(files, {
    commitSha: fixtureSha(FIXTURE, "HEAD"),
    repoId: "r_r06_chinese001",
  });
}, 180_000);

async function search(query: string): Promise<RetrievalHit[]> {
  const expanded = expandQuery(query);
  const rows = await createSourceSearcher().search(
    snapshot,
    DEFAULT_SCOPE,
    expanded.terms,
    { limit: 40 },
  );
  return rows.map((row) => ({
    kind: "source" as const,
    binding: {
      generationId: "g_r06_chinese001" as never,
      repoId: snapshot.repoId,
      commitSha: snapshot.commitSha,
    },
    path: row.path,
    lines: row.lines,
    preview: row.preview,
  }));
}

function cacheLines(hits: RetrievalHit[]): string[] {
  return hits
    .filter((hit) => hit.kind === "source" && hit.path === CACHE)
    .map((hit) => `${hit.lines?.start}-${hit.lines?.end}`);
}

describe("AC-R06-01 — Chinese and identifier questions", () => {
  it("expands the Chinese question into SnapshotCache/evict vocabulary", () => {
    const expanded = expandQuery(CHINESE);
    expect(expanded.terms).toContain("SnapshotCache");
    expect(expanded.terms).toContain("evict");
    expect(expanded.terms).toContain("snapshot");
  });

  it("preserves the identifier verbatim instead of translating it", () => {
    const expanded = expandQuery(IDENTIFIER);
    expect(expanded.symbolPreserved).toContain("snapshot_cache");
    expect(expanded.terms).toContain("snapshot_cache");
    expect(expanded.terms).toContain("SnapshotCache");
  });

  it("reaches the same snapshot_cache file and lines from both questions", async () => {
    const chineseHits = await search(CHINESE);
    const identifierHits = await search(IDENTIFIER);

    expect(
      chineseHits.some((hit) => hit.kind === "source" && hit.path === CACHE),
    ).toBe(true);
    expect(
      identifierHits.some((hit) => hit.kind === "source" && hit.path === CACHE),
    ).toBe(true);

    const chineseCache = cacheLines(chineseHits);
    const identifierCache = cacheLines(identifierHits);
    expect(chineseCache.length).toBeGreaterThan(0);
    expect(identifierCache).toEqual(chineseCache);
  });

  it("does not reach snapshot_cache for an unrelated question", async () => {
    const hits = await search("theming 里颜色怎么定");
    expect(
      hits.some((hit) => hit.kind === "source" && hit.path === CACHE),
    ).toBe(false);
    expect(hits).toEqual([]);
  });

  it("treats an empty or whitespace-only question as no query", async () => {
    for (const empty of ["", "   ", "\n\t  "]) {
      expect(expandQuery(empty)).toEqual({
        original: empty,
        terms: [],
        symbolPreserved: [],
      });
      await expect(search(empty)).resolves.toEqual([]);
    }
  });
});
