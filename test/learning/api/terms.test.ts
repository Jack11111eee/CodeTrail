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
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";
import { makeGeneration, makeProject, makeRepo } from "../store/helpers.ts";

/**
 * AC-UI-07 (API half) and the link half of AC-F08-01.
 *
 * The glossary is bilingual (`zh` and `en`), carries symbols and links to the
 * generation/source where the term appeared, and `?q` is filtered by the
 * repository — not by the handler.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

function seedGeneration(i: {
  projectId: string;
  repoId: string;
  generationId: string;
  commitSha: string;
}): void {
  const repoId = i.repoId as RepoId;
  const projectId = i.projectId as ProjectId;
  server!.repos.repos.upsert(
    makeRepo({
      repoId,
      identity: `local:/tmp/${i.repoId}`,
      mirrorPath: path.join(server!.paths.mirrors, `${i.repoId}.git`),
    }),
  );
  server!.repos.projects.insert(makeProject({ projectId, repoId }));
  server!.repos.generations.insertPublished(
    makeGeneration({
      generationId: i.generationId as GenerationId,
      repoId,
      projectId,
      cacheKey: `ck_${i.generationId}`,
      commitSha: i.commitSha,
      contentDir: path.join(server!.paths.knowledge, i.generationId),
      jobId: null,
    }),
  );
}

function seedTerm(i: {
  termId: string;
  zh: string;
  en: string;
  symbols: string[];
}): void {
  server!.db.raw
    .prepare(
      "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
    )
    .run(i.termId, i.zh, i.en, JSON.stringify(i.symbols));
}

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

beforeEach(async () => {
  server = await startRoutesServer([termsModule]);
  harness = await startHarness({ start: () => server! });

  seedGeneration({
    projectId: "p_1",
    repoId: "r_1",
    generationId: "g_1",
    commitSha: "a".repeat(40),
  });
  seedGeneration({
    projectId: "p_2",
    repoId: "r_2",
    generationId: "g_2",
    commitSha: "b".repeat(40),
  });

  seedTerm({
    termId: "t_snapshot",
    zh: "快照",
    en: "snapshot",
    symbols: ["SnapshotRecord"],
  });
  seedTerm({
    termId: "t_manifest",
    zh: "清单",
    en: "manifest",
    symbols: ["SealManifest"],
  });

  server.repos.terms.linkTerm({
    termId: "t_snapshot" as TermId,
    generationId: "g_1" as GenerationId,
    sourceId: "s_1" as SourceId,
  });
  server.repos.terms.linkTerm({
    termId: "t_snapshot" as TermId,
    generationId: "g_2" as GenerationId,
    sourceId: "s_2" as SourceId,
  });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("GET /api/terms", () => {
  it("returns zh, en, symbols and cross-project links", async () => {
    const body = jsonOf<TermListView>(await harness!.request("/api/terms"));
    expect(body.terms.map((term) => term.termId)).toEqual([
      "t_snapshot",
      "t_manifest",
    ]);

    const snapshot = body.terms.find(
      (term) => term.termId === "t_snapshot",
    ) as TermView;
    expect(snapshot.zh).toBe("快照");
    expect(snapshot.en).toBe("snapshot");
    expect(snapshot.symbols).toEqual(["SnapshotRecord"]);
    expect(snapshot.links).toEqual([
      {
        generationId: "g_1",
        repoId: "r_1",
        projectId: "p_1",
        sourceId: "s_1",
      },
      {
        generationId: "g_2",
        repoId: "r_2",
        projectId: "p_2",
        sourceId: "s_2",
      },
    ]);
  });

  it("filters server-side by Chinese name", async () => {
    const body = jsonOf<TermListView>(
      await harness!.request(`/api/terms?q=${encodeURIComponent("快照")}`),
    );
    expect(body.terms.map((term) => term.termId)).toEqual(["t_snapshot"]);
  });

  it("filters server-side by English name", async () => {
    const body = jsonOf<TermListView>(
      await harness!.request("/api/terms?q=manifest"),
    );
    expect(body.terms.map((term) => term.termId)).toEqual(["t_manifest"]);
  });

  it("returns an empty list when nothing matches and for an empty q", async () => {
    const missing = jsonOf<TermListView>(
      await harness!.request("/api/terms?q=zzz"),
    );
    expect(missing.terms).toEqual([]);

    const empty = jsonOf<TermListView>(await harness!.request("/api/terms?q="));
    expect(empty.terms).toHaveLength(2);
  });

  it("rejects an unknown query field with invalid_input", async () => {
    const response = await harness!.request("/api/terms?limit=3");
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: "invalid_input" } });
  });
});

describe("GET /api/terms/:id", () => {
  it("returns the detail with the same links", async () => {
    const term = jsonOf<TermView>(
      await harness!.request("/api/terms/t_snapshot"),
    );
    expect(term.termId).toBe("t_snapshot");
    expect(term.links).toHaveLength(2);
  });

  it("returns 404 not_found for an unknown term", async () => {
    const response = await harness!.request("/api/terms/t_absent");
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not_found" } });
  });
});
