import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newProjectId } from "../../../src/learning/contracts/index.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  type StubResponse,
} from "../helpers/stub-server.ts";
import {
  seedPublishedGeneration,
  startRoutesHarness,
  type RoutesHarness,
} from "../projects/routes-harness.ts";

/**
 * AC-API-03: unknown ids are `404 not_found`, a staged or failed generation is
 * `409 unpublished_generation`, an unconfigured model refuses a new analysis
 * with `400 model_not_configured`, and published content still reads. No error
 * is ever a 200 with an empty body.
 */

let server: RoutesHarness | undefined;
let projectId: string;
let repoId: string;

beforeEach(async () => {
  server = await startRoutesHarness({ model: null });
  const now = server.clock.now().toISOString();
  const repo = server.repos.repos.upsert({
    repoId: "r_api" as never,
    identity: "local:/tmp/api-fixture",
    kind: "local",
    mirrorPath: "/tmp/api-fixture.git",
    remoteUrl: null,
    createdAt: now,
  });
  repoId = repo.repoId;
  projectId = newProjectId();
  server.repos.projects.insert({
    projectId: projectId as never,
    repoId,
    kind: "local",
    displayName: "api-fixture",
    remoteUrl: null,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: now,
    deletedAt: null,
  });

  const at = now;
  const base = {
    cacheKey: "ck_staged",
    repoId,
    projectId: projectId as never,
    commitSha: "a".repeat(40),
    comparisonBaseSha: null,
    kind: "research" as const,
    scopeHash: "scope",
    configHash: "config",
    promptTemplateVersion: "prompt",
    preferencesVersion: 1,
    upstreamVersion: "upstream",
    contentDir: "g_staged",
    sealedTreeHash: null,
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: at,
    publishedAt: null,
  };
  server.repos.generations.insertPublished({
    ...base,
    generationId: "g_staged" as never,
    status: "staged",
  });
  server.repos.generations.insertPublished({
    ...base,
    generationId: "g_failed" as never,
    cacheKey: "ck_failed",
    status: "failed",
  });

  await seedPublishedGeneration(server, {
    generationId: "g_pub",
    repoId,
    projectId,
    commitSha: "b".repeat(40),
    lessonId: "l_pub",
    lessonTitle: "published",
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function get(path: string): Promise<StubResponse> {
  return httpRequest(server!.port, { path, headers: { ...server!.cookie } });
}

describe("not found and unpublished", () => {
  it("returns 404 not_found for unknown ids and paths", async () => {
    for (const path of [
      "/api/projects/p_missing",
      "/api/jobs/j_missing",
      "/api/generations/g_missing/lessons",
      "/api/generations/g_missing/lessons/l_missing",
      "/api/generations/g_missing/sources/s_missing",
      "/api/generations/g_missing/coverage",
      "/api/nothing-here",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe("not_found");
      expect(response.text.length).toBeGreaterThan(0);
    }
  });

  it("returns 409 unpublished_generation for staged and failed rows on every read", async () => {
    for (const [generationId, status] of [
      ["g_staged", "staged"],
      ["g_failed", "failed"],
    ] as const) {
      for (const path of [
        `/api/generations/${generationId}/lessons`,
        `/api/generations/${generationId}/lessons/l_pub`,
        `/api/generations/${generationId}/sources/s_any`,
        `/api/generations/${generationId}/coverage`,
      ]) {
        const response = await get(path);
        expect(response.status).toBe(409);
        expect(errorCode(response)).toBe("unpublished_generation");
        const body = jsonBody(response) as {
          error?: { details?: { status?: string } };
        };
        expect(body.error?.details?.status).toBe(status);
      }
    }
  });

  it("reports unpublished before an unknown or foreign lesson id", async () => {
    // Resolution order (§5.8): row absent → 404; not published → 409; removed
    // → 410. A staged generation therefore never leaks a version_mismatch or a
    // 404 for its children.
    const response = await get("/api/generations/g_staged/lessons/l_pub");
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("unpublished_generation");
  });

  it("fails a new analysis with 400 model_not_configured", async () => {
    const response = await httpRequest(server!.port, {
      method: "POST",
      path: `/api/projects/${projectId}/analyses`,
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "HEAD" }),
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("model_not_configured");
  });

  it("still serves published content with 200", async () => {
    const response = await get("/api/generations/g_pub/lessons/l_pub");
    expect(response.status).toBe(200);
    expect(jsonBody(response)).toMatchObject({
      lesson: { lessonId: "l_pub" },
    });
  });

  it("never answers an error with 200 and an empty body", async () => {
    for (const path of [
      "/api/projects/p_missing",
      "/api/generations/g_staged/lessons",
      "/api/nothing-here",
    ]) {
      const response = await get(path);
      expect(response.status).not.toBe(200);
      expect(response.text.length).toBeGreaterThan(0);
      expect(errorCode(response)).toBeTypeOf("string");
    }
  });
});
