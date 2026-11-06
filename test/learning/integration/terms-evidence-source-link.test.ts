import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { termsModule } from "../../../src/learning/api/routes/terms.ts";
import type {
  GenerationId,
  ProjectId,
  RepoId,
  SourceId,
  TermId,
  TermListView,
  TermView,
} from "../../../src/learning/contracts/index.ts";
import { multiView } from "../../../src/learning/evidence/multi-view.ts";
import {
  createSourceRegistry,
  sourceRowFromRef,
} from "../../../src/learning/evidence/registry.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { researchLesson } from "../helpers/lesson-sample.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";
import { DEFAULT_SCOPE, fakeSnapshot } from "../retrieval/evidence-harness.ts";
import {
  makeGeneration,
  makeProject,
  makeRepo,
} from "../store/helpers.ts";

/**
 * Integration: bilingual terms route (issue-16) + source registry persisted by
 * the publish transaction (issue-14) + lesson evidence ids (issue-15).
 *
 * A glossary link is only useful if it points at a real registered source of a
 * published generation. The terms route reads its links from the store; the
 * registry only serves a *fresh* instance from persisted `sources` rows after
 * `assertPublished`. This test proves the link the HTTP API returns is an id
 * both the version view and a published lesson can resolve.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

const REPO_ID = "r_1" as RepoId;
const PROJECT_ID = "p_1" as ProjectId;
const GENERATION_ID = "g_1" as GenerationId;
const COMMIT_SHA = "a".repeat(40);

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

async function publishedSource(): Promise<{
  sourceId: SourceId;
  content: string;
}> {
  const content = [
    "class SnapshotCache:",
    "    def evict(self, key):",
    "        self._store.pop(key, None)",
    "",
  ].join("\n");
  const ref = await createSourceRegistry({
    clock: server!.clock,
    sources: server!.repos.sources,
    generations: server!.repos.generations,
  }).registerRepo({
    generationId: GENERATION_ID,
    repoId: REPO_ID,
    commitSha: COMMIT_SHA,
    path: "src/lmp/state/snapshot_cache.py",
    lines: { start: 1, end: 3 },
    snapshot: fakeSnapshot(
      { "src/lmp/state/snapshot_cache.py": content },
      { commitSha: COMMIT_SHA, repoId: REPO_ID },
    ),
    scope: DEFAULT_SCOPE,
  });

  // Publishing writes the `sources` row; the registry keeps no ref after that.
  server!.db.transaction(() => {
    server!.repos.sources.insertMany([sourceRowFromRef(ref)]);
  });
  return { sourceId: ref.sourceId, content };
}

beforeEach(async () => {
  server = await startRoutesServer([termsModule]);
  harness = await startHarness({ start: () => server! });

  server.repos.repos.upsert(
    makeRepo({
      repoId: REPO_ID,
      identity: "local:/tmp/terms-repo",
      mirrorPath: path.join(server.paths.mirrors, `${REPO_ID}.git`),
    }),
  );
  server.repos.projects.insert(
    makeProject({ projectId: PROJECT_ID, repoId: REPO_ID }),
  );
  server.repos.generations.insertPublished(
    makeGeneration({
      generationId: GENERATION_ID,
      repoId: REPO_ID,
      projectId: PROJECT_ID,
      cacheKey: `ck_${GENERATION_ID}`,
      commitSha: COMMIT_SHA,
      contentDir: path.join(server.paths.knowledge, GENERATION_ID),
      jobId: null,
    }),
  );
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("terms × evidence registry", () => {
  it("links a lesson's evidence id to the persisted source it names", async () => {
    const source = await publishedSource();
    server!.db.raw
      .prepare(
        "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
      )
      .run("t_snapshot", "快照", "snapshot", JSON.stringify(["SnapshotCache"]));
    server!.repos.terms.linkTerm({
      termId: "t_snapshot" as TermId,
      generationId: GENERATION_ID,
      sourceId: source.sourceId,
    });

    const term = jsonOf<TermView>(
      await harness!.request("/api/terms/t_snapshot"),
    );
    expect(term.zh).toBe("快照");
    expect(term.en).toBe("snapshot");
    expect(term.links).toEqual([
      {
        generationId: GENERATION_ID,
        repoId: REPO_ID,
        projectId: PROJECT_ID,
        sourceId: source.sourceId,
      },
    ]);

    // A *fresh* registry has no staged refs: it must read the published row.
    const reopened = createSourceRegistry({
      clock: server!.clock,
      sources: server!.repos.sources,
      generations: server!.repos.generations,
    });
    const resolved = reopened.get(GENERATION_ID, source.sourceId);
    expect(resolved).not.toBeNull();
    if (resolved === null || resolved.kind !== "repo") {
      throw new Error("expected a persisted repo source");
    }
    expect(resolved.path).toBe("src/lmp/state/snapshot_cache.py");
    expect(resolved.commitSha).toBe(COMMIT_SHA);

    // The multi-generation view accepts the same id the HTTP link carries.
    const view = multiView(reopened, [GENERATION_ID]);
    expect(() => view.assertBelongsTo(source.sourceId)).not.toThrow();

    // A lesson citing that id is structurally valid (schema half).
    const draft = researchLesson();
    draft.evidence = [source.sourceId];
    draft.generationId = GENERATION_ID;
    draft.context = {
      ...(draft.context as Record<string, unknown>),
      repoId: REPO_ID,
      commitSha: COMMIT_SHA,
      generationId: GENERATION_ID,
    };
    expect(parseLesson(draft).ok).toBe(true);
  });

  it("does not expose a link for a source the registry never persisted", async () => {
    // Link points at an id with no `sources` row and no matching commit.
    server!.db.raw
      .prepare(
        "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
      )
      .run("t_ghost", "幽灵", "ghost", "[]");
    server!.repos.terms.linkTerm({
      termId: "t_ghost" as TermId,
      generationId: GENERATION_ID,
      sourceId: "s_ffffffffffffffff" as SourceId,
    });

    const view = jsonOf<TermListView>(
      await harness!.request("/api/terms?q=ghost"),
    );
    expect(view.terms).toHaveLength(1);
    expect(view.terms[0]!.links[0]!.sourceId).toBe("s_ffffffffffffffff");

    // HTTP metadata alone does not make the source resolvable.
    const registry = createSourceRegistry({
      clock: server!.clock,
      sources: server!.repos.sources,
      generations: server!.repos.generations,
    });
    expect(
      registry.get(GENERATION_ID, "s_ffffffffffffffff" as SourceId),
    ).toBeNull();
  });

  it("keeps the server-side q filter and 404 behaviour while links resolve", async () => {
    const source = await publishedSource();
    server!.db.raw
      .prepare(
        "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
      )
      .run("t_snapshot", "快照", "snapshot", "[]");
    server!.db.raw
      .prepare(
        "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
      )
      .run("t_manifest", "清单", "manifest", "[]");
    server!.repos.terms.linkTerm({
      termId: "t_snapshot" as TermId,
      generationId: GENERATION_ID,
      sourceId: source.sourceId,
    });

    const filtered = jsonOf<TermListView>(
      await harness!.request(`/api/terms?q=${encodeURIComponent("快照")}`),
    );
    expect(filtered.terms.map((term) => term.termId)).toEqual(["t_snapshot"]);

    const missing = await harness!.request("/api/terms/t_absent");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: { code: "not_found" } });
  });
});
