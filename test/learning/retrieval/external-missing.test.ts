import { describe, expect, it } from "vitest";

import {
  LearningError,
  type GenerationId,
  type RepoId,
} from "../../../src/learning/contracts/index.js";
import { createExternalDocService } from "../../../src/learning/evidence/external.js";
import { sourceRowFromRef } from "../../../src/learning/evidence/registry.js";
import {
  DEFAULT_SCOPE,
  HEAD_SHA,
  createEvidenceHarness,
  fakeSnapshot,
  makeGeneration,
  type EvidenceHarness,
} from "./evidence-harness.js";

const ALLOWED_URL = "https://docs.python.org/3/library/asyncio-task.html";

function thrownBy(fn: () => unknown): LearningError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LearningError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a LearningError");
}

async function unavailableDocument(
  harness: EvidenceHarness,
): Promise<
  Awaited<ReturnType<ReturnType<typeof createExternalDocService>["fetchExact"]>>
> {
  const external = createExternalDocService({
    paths: harness.paths,
    clock: harness.clock,
    resolve: () => Promise.resolve(["93.184.216.34"]),
    fetchImpl: () => Promise.resolve(new Response("gone", { status: 404 })),
  });
  return external.fetchExact({ url: ALLOWED_URL, locator: "background" });
}

describe("missing external documents", () => {
  it("yields a source_missing gap with no external id, URL or version", async () => {
    const harness = await createEvidenceHarness();
    const generationId = "g_1" as GenerationId;
    try {
      const generation = makeGeneration({ generationId });
      harness.db.transaction(() => {
        harness.repos.generations.insertPublished(generation);
      });

      // The fetch failed: there is no canonical URL, version or hash to store.
      const result = await unavailableDocument(harness);
      expect(result).toEqual({
        ok: false,
        status: "source_missing",
        reason: "not_found",
      });
      expect(Object.keys(result).sort()).toEqual(["ok", "reason", "status"]);

      // `registerExternal` must never fabricate a ref from a failed result.
      harness.registry.bindGeneration(generationId);
      const error = thrownBy(() => harness.registry.registerExternal(result));
      expect(error.code).toBe("external_source_unavailable");

      // The builder records the gap instead of a ref.
      harness.registry.recordGap(generationId, {
        kind: "external",
        status: "source_missing",
        subject: "attention mechanism background",
        reason: "not_found",
      });

      // Repository evidence still registers and stays explainable.
      const repo = await harness.registry.registerRepo({
        generationId,
        repoId: "r_1" as RepoId,
        commitSha: HEAD_SHA,
        path: "src/attention.ts",
        lines: { start: 1, end: 2 },
        snapshot: fakeSnapshot({
          "src/attention.ts": "export function attend() {\n  return 1;\n}\n",
        }),
        scope: DEFAULT_SCOPE,
      });

      expect(harness.registry.get(generationId, repo.sourceId)).toEqual(repo);
      expect(harness.registry.all(generationId)).toEqual([repo]);

      const gaps = harness.registry.gaps(generationId);
      expect(gaps).toEqual([
        {
          kind: "external",
          status: "source_missing",
          subject: "attention mechanism background",
          reason: "not_found",
        },
      ]);
      // A gap carries no source id.
      expect("sourceId" in gaps[0]).toBe(false);

      // Publication still succeeds: the generation is published and the repo
      // source row is part of the same all-or-nothing transaction.
      let published = false;
      harness.db.transaction(() => {
        harness.repos.sources.insertMany([sourceRowFromRef(repo)]);
        published = true;
      });
      expect(published).toBe(true);
      expect(harness.repos.generations.byId(generationId)?.status).toBe(
        "published",
      );
      expect(harness.repos.sources.all(generationId)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("reports network failures as source_missing/network", async () => {
    const harness = await createEvidenceHarness();
    try {
      const external = createExternalDocService({
        paths: harness.paths,
        clock: harness.clock,
        resolve: () => Promise.reject(new Error("ENOTFOUND")),
        fetchImpl: () => Promise.reject(new Error("should not fetch")),
      });
      expect(
        await external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).toEqual({ ok: false, status: "source_missing", reason: "network" });
    } finally {
      harness.close();
    }
  });
});
