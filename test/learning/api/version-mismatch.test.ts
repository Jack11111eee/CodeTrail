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
 * AC-API-04: a lesson or source id from another generation is a 409
 * `version_mismatch` naming the real owner — not a 404 and not a silent read of
 * the wrong version.
 */

let server: RoutesHarness | undefined;
let repoId: string;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

beforeEach(async () => {
  server = await startRoutesHarness();
  const now = server.clock.now().toISOString();
  const repo = server.repos.repos.upsert({
    repoId: "r_versions" as never,
    identity: "local:/tmp/versions-fixture",
    kind: "local",
    mirrorPath: "/tmp/versions-fixture.git",
    remoteUrl: null,
    createdAt: now,
  });
  repoId = repo.repoId;
  const projectId = newProjectId();
  server.repos.projects.insert({
    projectId: projectId,
    repoId,
    kind: "local",
    displayName: "versions-fixture",
    remoteUrl: null,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: now,
    deletedAt: null,
  });

  await seedPublishedGeneration(server, {
    generationId: "g_a",
    repoId,
    projectId,
    commitSha: SHA_A,
    lessonId: "l_a",
    lessonTitle: "A",
    sourceId: "s_a",
    sourcePath: "README.md",
    sourceCommitSha: SHA_A,
  });
  await seedPublishedGeneration(server, {
    generationId: "g_b",
    repoId,
    projectId,
    commitSha: SHA_B,
    lessonId: "l_b",
    lessonTitle: "B",
    sourceId: "s_b",
    sourcePath: "README.md",
    sourceCommitSha: SHA_B,
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function get(path: string): Promise<StubResponse> {
  return httpRequest(server!.port, { path, headers: { ...server!.cookie } });
}

describe("cross-generation combinations", () => {
  it("rejects a lesson id owned by another generation", async () => {
    const response = await get("/api/generations/g_b/lessons/l_a");
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("version_mismatch");
    const body = jsonBody(response) as {
      error?: { details?: { ownerGenerationId?: string } };
    };
    expect(body.error?.details?.ownerGenerationId).toBe("g_a");
  });

  it("rejects a source id owned by another generation", async () => {
    const response = await get("/api/generations/g_b/sources/s_a");
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("version_mismatch");
    const body = jsonBody(response) as {
      error?: { details?: { ownerGenerationId?: string } };
    };
    expect(body.error?.details?.ownerGenerationId).toBe("g_a");
  });

  it("distinguishes an unknown id from a foreign one", async () => {
    const unknown = await get("/api/generations/g_b/lessons/l_never");
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
  });

  it("serves the owning generation's own lesson", async () => {
    const own = await get("/api/generations/g_b/lessons/l_b");
    expect(own.status).toBe(200);
    expect(jsonBody(own)).toMatchObject({
      lesson: { lessonId: "l_b", generationId: "g_b" },
    });
  });
});
