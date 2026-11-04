import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RetrievalHit } from "../../../src/learning/contracts/index.js";
import {
  createIndexCache,
  createRetriever,
} from "../../../src/learning/retrieval/search.js";
import { createSourceSearcher } from "../../../src/learning/retrieval/source-search.js";
import { createUpstreamRetrievalPort } from "../../../src/learning/upstream/retrieval.js";
import { DEFAULT_SCOPE, fakeSnapshot } from "./evidence-harness.js";
import {
  cleanupKnowledgeDirs,
  makeBinding,
  makeKnowledgeDir,
} from "./retrieval-helpers.js";

/**
 * AC-RET-03: the Chinese question 旧快照丢了为什么会这样 over `last-mile-mini`
 * returns a top-3 wiki hit naming `snapshot_cache.py`/`SnapshotCache`, and the
 * hit carries the requested binding.
 *
 * The knowledge directory is assembled from the real fixture files (no job
 * run: `api/jobs` is a same-wave sibling), so the page text is grounded in the
 * repository the question is about.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/make-fixtures.mjs");

let outDir = "";
let knowledgeDir = "";
let sourceFiles: Record<string, string> = {};

function buildFixtures(target: string): void {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--out", target, "--quiet"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    throw new Error(`fixtures failed: ${result.stdout}\n${result.stderr}`);
  }
}

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-recall-"));
  buildFixtures(outDir);
  const fixture = path.join(outDir, "fixtures", "last-mile-mini");
  const read = (relative: string): string =>
    fs.readFileSync(path.join(fixture, relative), "utf8");

  sourceFiles = {
    "src/lmp/state/snapshot_cache.py": read("src/lmp/state/snapshot_cache.py"),
    "app/screens.py": read("app/screens.py"),
    "src/lmp/adapters/mock/server.py": read(
      "src/lmp/adapters/mock/server.py",
    ),
    "docs/decisions/decision-log.md": read("docs/decisions/decision-log.md"),
  };

  knowledgeDir = await makeKnowledgeDir({
    "snapshot-cache.md": [
      "---",
      "type: Guide",
      "title: Snapshot cache eviction",
      "---",
      "",
      "# Snapshot cache eviction",
      "",
      "`src/lmp/state/snapshot_cache.py` defines `SnapshotCache`, which caches",
      "immutable approval snapshots by shipment id.",
      "",
      "## Why an old snapshot is dropped",
      "",
      "The cache calls `SnapshotCache.evict` when a snapshot is stale. An",
      "evicted snapshot is rebuilt from the current state, so the approval",
      "screen never shows the previous attempt.",
    ].join("\n"),
    "approval-flow.md": [
      "---",
      "type: Guide",
      "title: Approval flow",
      "---",
      "",
      "# Approval flow",
      "",
      "The shipment screen reads an approval snapshot through `SnapshotCache`.",
      "",
      "## Eviction boundary",
      "",
      "An eviction invalidates the cached snapshot and the next read rebuilds",
      "it. The mock server approves directly instead of re-validating.",
    ].join("\n"),
    "decision-log.md": [
      "---",
      "type: Record",
      "title: Decision log",
      "---",
      "",
      "# Decision log",
      "",
      "## Snapshot handling",
      "",
      "D-057 and D-063 record why a stale snapshot is evicted. `SnapshotCache`",
      "keeps the cache bounded; `evict` removes one shipment id.",
    ].join("\n"),
    "theming.md": [
      "---",
      "type: Guide",
      "title: Theming",
      "---",
      "",
      "# Theming",
      "",
      "The dashboard uses a muted palette for shipment rows.",
    ].join("\n"),
  });
}, 180_000);

afterAll(async () => {
  await cleanupKnowledgeDirs();
  if (outDir !== "") {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

function textOf(hit: RetrievalHit): string {
  return `${hit.page ?? ""}\n${hit.preview}`;
}

describe("Chinese question recall over last-mile-mini", () => {
  it("returns a top-3 hit naming snapshot_cache.py or SnapshotCache", async () => {
    const calls: string[] = [];
    const binding = makeBinding();
    const upstream = createUpstreamRetrievalPort();
    const retriever = createRetriever({
      upstream: {
        search(...args) {
          calls.push("upstream");
          return upstream.search(...args);
        },
        readSections: upstream.readSections.bind(upstream),
        pageTitle: upstream.pageTitle.bind(upstream),
      },
      source: {
        search(...args) {
          calls.push("source");
          return createSourceSearcher().search(...args);
        },
      },
      cache: createIndexCache(),
      resolve: () => ({
        wiki: {
          state: "published",
          generationId: binding.generationId,
          commitSha: binding.commitSha,
          knowledgeDir,
          sealedTreeHash: `sha256:${"0".repeat(64)}`,
        },
        snapshot: fakeSnapshot(sourceFiles, {
          commitSha: binding.commitSha,
          repoId: binding.repoId,
        }),
        scope: DEFAULT_SCOPE,
      }),
    });

    const hits = await retriever.search(binding, "旧快照丢了为什么会这样");

    expect(calls).toContain("upstream");
    expect(hits.length).toBeGreaterThan(0);

    const top3 = hits.slice(0, 3);
    const naming = top3.filter((hit) =>
      /snapshot_cache\.py|SnapshotCache/u.test(textOf(hit)),
    );
    expect(
      naming.length,
      `top3 pages: ${top3.map((hit) => hit.page).join(", ")}`,
    ).toBeGreaterThan(0);

    for (const hit of hits) {
      expect(hit.binding).toEqual(binding);
    }
  });

  it("quotes the fixture's real snapshot cache code in the fallback", async () => {
    const binding = makeBinding();
    const retriever = createRetriever({
      upstream: createUpstreamRetrievalPort(),
      source: createSourceSearcher(),
      cache: createIndexCache(),
      resolve: () => ({
        wiki: null,
        snapshot: fakeSnapshot(sourceFiles, {
          commitSha: binding.commitSha,
          repoId: binding.repoId,
        }),
        scope: DEFAULT_SCOPE,
      }),
    });

    const hits = await retriever.search(binding, "旧快照丢了为什么会这样", {
      limit: 5,
    });
    const source = hits.filter((hit) => hit.kind === "source");
    expect(source.length).toBeGreaterThan(0);
    expect(source.map((hit) => hit.path)).toContain(
      "src/lmp/state/snapshot_cache.py",
    );
    for (const hit of source) {
      expect(hit.lines.start).toBeGreaterThan(0);
      expect(hit.binding).toEqual(binding);
    }
  });
});
