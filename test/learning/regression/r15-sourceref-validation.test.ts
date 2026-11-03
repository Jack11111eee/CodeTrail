/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * AC-R15-01: every source kind is validated by its own structure. Repo sources
 * are checked against the immutable snapshot (path, scope, commit, line range),
 * external sources need an https URL plus a version and a real fetch result,
 * and teaching examples carry only their own identity. Invalid ids and paths
 * surface as 404/409/403 at the HTTP boundary, and an unavailable external
 * source can never become an invented citation.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  LearningError,
  type GenerationId,
  type RepoId,
} from "../../../src/learning/contracts/index.ts";
import { createSourceRegistry } from "../../../src/learning/evidence/registry.ts";
import { createSourceReader } from "../../../src/learning/evidence/registry.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { fakeSnapshot, fixedClock } from "../helpers/lesson-context.ts";
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

const GENERATION = "g_r15_matrix00000" as GenerationId;
const REPO = "r_r15_matrix00000" as RepoId;
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

function registry(): ReturnType<typeof createSourceRegistry> {
  return createSourceRegistry({
    clock: fixedClock(),
    sources: {
      get: () => null,
      all: () => [],
    } as never,
    generations: {
      byId: () => null,
    } as never,
  });
}

async function rejection(promise: Promise<unknown>): Promise<LearningError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    return error as LearningError;
  }
  throw new Error("expected the call to reject");
}

function thrownBy(action: () => unknown): LearningError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    return error as LearningError;
  }
  throw new Error("expected the call to throw");
}

const FILES = {
  "src/index.ts": "export const value = 1;\nexport const other = 2;\n",
};

describe("AC-R15-01 — structural source validation", () => {
  it("repo sources validate path, scope, commit and lines", async () => {
    const sources = registry();
    const snapshot = fakeSnapshot(FILES, { commitSha: COMMIT, repoId: REPO });
    const scope = normalizeScope();

    const whole = await sources.registerRepo({
      generationId: GENERATION,
      repoId: REPO,
      commitSha: COMMIT,
      path: "src/index.ts",
      lines: null,
      snapshot,
      scope,
    });
    expect(whole.kind).toBe("repo");
    expect(whole.commitSha).toBe(COMMIT);
    expect(whole.lines).toBeNull();
    expect(whole.contentHash).not.toBe("");

    const ranged = await sources.registerRepo({
      generationId: GENERATION,
      repoId: REPO,
      commitSha: COMMIT,
      path: "src/index.ts",
      lines: { start: 1, end: 1 },
      snapshot,
      scope,
    });
    expect(ranged.sourceId).not.toBe(whole.sourceId);
    expect(ranged.contentHash).not.toBe(whole.contentHash);

    // Out-of-scope traversal is 403 before any read.
    const traversal = await rejection(
      sources.registerRepo({
        generationId: GENERATION,
        repoId: REPO,
        commitSha: COMMIT,
        path: "../outside.ts",
        lines: null,
        snapshot,
        scope,
      }),
    );
    expect(traversal.code).toBe("out_of_scope_path");
    expect(traversal.status).toBe(403);

    // A missing file is 404, never an empty source.
    const missing = await rejection(
      sources.registerRepo({
        generationId: GENERATION,
        repoId: REPO,
        commitSha: COMMIT,
        path: "src/missing.ts",
        lines: null,
        snapshot,
        scope,
      }),
    );
    expect(missing.code).toBe("not_found");
    expect(missing.status).toBe(404);

    // Invalid line ranges are 400.
    for (const lines of [
      { start: 2, end: 1 },
      { start: 0, end: 1 },
      { start: 1, end: 99 },
    ]) {
      const invalid = await rejection(
        sources.registerRepo({
          generationId: GENERATION,
          repoId: REPO,
          commitSha: COMMIT,
          path: "src/index.ts",
          lines,
          snapshot,
          scope,
        }),
      );
      expect(invalid.code).toBe("invalid_input");
      expect(invalid.status).toBe(400);
    }

    // A snapshot bound to another commit is 409; another repo is 400.
    const wrongCommit = await rejection(
      sources.registerRepo({
        generationId: GENERATION,
        repoId: REPO,
        commitSha: COMMIT,
        path: "src/index.ts",
        lines: null,
        snapshot: fakeSnapshot(FILES, {
          commitSha: OTHER_COMMIT,
          repoId: REPO,
        }),
        scope,
      }),
    );
    expect(wrongCommit.code).toBe("version_mismatch");
    expect(wrongCommit.status).toBe(409);

    const wrongRepo = await rejection(
      sources.registerRepo({
        generationId: GENERATION,
        repoId: REPO,
        commitSha: COMMIT,
        path: "src/index.ts",
        lines: null,
        snapshot: fakeSnapshot(FILES, {
          commitSha: COMMIT,
          repoId: "r_r15_other000000",
        }),
        scope,
      }),
    );
    expect(wrongRepo.code).toBe("invalid_input");
    expect(wrongRepo.status).toBe(400);
  });

  it("external sources need an https URL, a version and a real fetch", async () => {
    const sources = registry();
    sources.bindGeneration(GENERATION);

    const ref = sources.registerExternal({
      ok: true,
      canonicalUrl: "https://example.test/design",
      versionOrRetrievedAt: "v2.4.0",
      locator: "#section-2",
      contentHash: "sha256:abc",
      title: "Design",
    });
    expect(ref.kind).toBe("external");
    expect(ref.canonicalUrl).toBe("https://example.test/design");
    expect(ref.versionOrRetrievedAt).toBe("v2.4.0");
    // No repo fields on an external ref.
    expect("path" in ref).toBe(false);
    expect("commitSha" in ref).toBe(false);

    const failed = thrownBy(() =>
      sources.registerExternal({
        ok: false,
        status: "source_missing",
        reason: "not_found",
      }),
    );
    expect(failed.code).toBe("external_source_unavailable");
    expect(failed.status).toBe(502);

    const http = thrownBy(() =>
      sources.registerExternal({
        ok: true,
        canonicalUrl: "http://example.test/design",
        versionOrRetrievedAt: "v1",
        locator: "",
        contentHash: "sha256:abc",
        title: "Design",
      }),
    );
    expect(http.code).toBe("invalid_input");

    const missingVersion = thrownBy(() =>
      sources.registerExternal({
        ok: true,
        canonicalUrl: "https://example.test/design",
        versionOrRetrievedAt: "",
        locator: "",
        contentHash: "sha256:abc",
        title: "Design",
      }),
    );
    expect(missingVersion.code).toBe("invalid_input");

    // An unavailable external never becomes a citation: the reader refuses.
    const reader = createSourceReader({
      snapshotFor: () =>
        fakeSnapshot(FILES, { commitSha: COMMIT, repoId: REPO }),
      external: {
        fetchExact: async () => ({
          ok: false,
          status: "source_missing",
          reason: "not_found",
        }),
        cached: async () => null,
      },
    });
    const unavailable = await rejection(reader.readExternal(ref));
    expect(unavailable.code).toBe("external_source_unavailable");
    expect(unavailable.status).toBe(502);
  });

  it("teaching examples carry only their own identity", async () => {
    const sources = registry();
    sources.bindGeneration(GENERATION);

    const ref = sources.registerTeachingExample({
      exampleId: "ex1",
      label: "示例：slugify",
    });
    expect(ref.kind).toBe("teaching_example");
    expect(ref.exampleId).toBe("ex1");
    expect(ref.label).toContain("示例");
    expect("commitSha" in ref).toBe(false);
    expect("path" in ref).toBe(false);

    // Repo-shaped extra fields are ignored: the kind is its own structure.
    const withRepoFields = sources.registerTeachingExample({
      exampleId: "ex2",
      label: "示例：parse",
      path: "src/index.ts",
      commitSha: COMMIT,
    } as unknown as { exampleId: string; label: string });
    expect("commitSha" in withRepoFields).toBe(false);
    expect("path" in withRepoFields).toBe(false);

    for (const bad of [
      { exampleId: "", label: "示例" },
      { exampleId: "ex3", label: "" },
    ]) {
      const error = thrownBy(() => sources.registerTeachingExample(bad));
      expect(error.code).toBe("invalid_input");
      expect(error.status).toBe(400);
    }
  });
});

describe("AC-R15-01 — HTTP statuses for invalid source ids", () => {
  let server: RoutesHarness | undefined;
  let repoId: string;

  async function start(): Promise<void> {
    server = await startRoutesHarness();
    const now = server.clock.now().toISOString();
    const repo = server.repos.repos.upsert({
      repoId: "r_r15_http000000" as never,
      identity: "local:/tmp/r15-http",
      kind: "local",
      mirrorPath: "/tmp/r15-http.git",
      remoteUrl: null,
      createdAt: now,
    });
    repoId = repo.repoId;
    const projectId = "p_r15_http" as never;
    server.repos.projects.insert({
      projectId,
      repoId,
      kind: "local",
      displayName: "r15-http",
      remoteUrl: null,
      defaultBranch: "main",
      scope: normalizeScope(),
      watchEnabled: false,
      createdAt: now,
      deletedAt: null,
    });
    await seedPublishedGeneration(server, {
      generationId: "g_r15_http_a",
      repoId,
      projectId,
      commitSha: COMMIT,
      lessonId: "l_r15_a",
      lessonTitle: "A",
      sourceId: "s_r15_a",
      sourcePath: "README.md",
      sourceCommitSha: COMMIT,
    });
    await seedPublishedGeneration(server, {
      generationId: "g_r15_http_b",
      repoId,
      projectId,
      commitSha: OTHER_COMMIT,
      lessonId: "l_r15_b",
      lessonTitle: "B",
      sourceId: "s_r15_b",
      sourcePath: "README.md",
      sourceCommitSha: OTHER_COMMIT,
    });
  }

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function get(pathname: string): Promise<StubResponse> {
    return httpRequest(server!.port, {
      path: pathname,
      headers: { ...server!.cookie },
    });
  }

  it("returns 404 for an unknown source, 409 for a foreign one and 403 for a path", async () => {
    await start();

    const unknown = await get("/api/generations/g_r15_http_b/sources/s_never");
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");

    const foreign = await get("/api/generations/g_r15_http_b/sources/s_r15_a");
    expect(foreign.status).toBe(409);
    expect(errorCode(foreign)).toBe("version_mismatch");
    expect(
      (
        jsonBody(foreign) as {
          error?: { details?: { ownerGenerationId?: string } };
        }
      ).error?.details?.ownerGenerationId,
    ).toBe("g_r15_http_a");

    const traversal = await get(
      "/api/generations/g_r15_http_b/sources/..%2F..%2Fetc%2Fpasswd",
    );
    expect(traversal.status).toBe(403);
    expect(errorCode(traversal)).toBe("out_of_scope_path");
  });
});
