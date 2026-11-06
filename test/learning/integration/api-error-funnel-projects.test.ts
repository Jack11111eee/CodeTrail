import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRouteModule, ROUTES } from "../../../src/learning/api/router.ts";
import {
  LearningError,
  type RouteModule,
  type SnapshotRecord,
  type SnapshotService,
} from "../../../src/learning/contracts/index.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ClonedFixture,
  type ProjectsHarness,
} from "../projects/harness.ts";
import {
  httpRequest,
  jsonBody,
  startStubServer,
  type StubRequestOptions,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * Integration: real projects-layer failures (`LearningError`s from
 * `projects/snapshot.ts`, `projects/worktree.ts` and `projects/scope.ts`)
 * crossing the merged api-core funnel (`api/server.ts` → `contracts/errors.ts`
 * → `api/respond.ts`), plus request-schema validation feeding `normalizeScope`.
 *
 * Nothing here re-implements the layer under test: the handlers call the real
 * snapshot service, and the assertions are on the HTTP status, the fixed error
 * body shape and the scope hash that the validated body produces.
 */

const ANALYSES_ROUTE = ROUTES.find(
  (route) => route.pattern === "/api/projects/:id/analyses",
);
const SOURCE_ROUTE = ROUTES.find(
  (route) => route.pattern === "/api/generations/:id/sources/:sourceId",
);
if (ANALYSES_ROUTE === undefined || SOURCE_ROUTE === undefined) {
  throw new Error("analyses/source routes missing from the frozen route table");
}

const CANARY = "ct-canary-do-not-leak-0001";

let harness: ProjectsHarness | undefined;
let fixture: ClonedFixture | undefined;
let snap: SnapshotRecord | undefined;
let service: SnapshotService | undefined;
let server: StubServer | undefined;
let analysesCalls = 0;
let sourceCalls = 0;

const SOURCE_PATHS = new Map<string, string>([
  ["app", "src/app.py"],
  ["env", ".env"],
  ["missing", "missing.py"],
]);

beforeEach(async () => {
  analysesCalls = 0;
  sourceCalls = 0;

  harness = await createHarness();
  fixture = await cloneFixture(harness, "scope-hygiene");
  service = createSnapshotService({
    paths: harness.paths,
    repos: harness.repos,
    clock: harness.clock,
  });
  snap = await service.ensure(fixture.repo.repoId, fixture.sha);

  const generations: RouteModule = {
    id: "generations",
    routes: [SOURCE_ROUTE],
    handlers: {
      "generations.source": () => async (req) => {
        sourceCalls += 1;
        const sourceId = req.params.sourceId ?? "";
        if (sourceId === "boom") {
          throw new TypeError(`boom ${harness!.paths.root}`);
        }
        const relPath = SOURCE_PATHS.get(sourceId);
        if (relPath === undefined) {
          throw new LearningError("not_found", "来源不存在", { sourceId });
        }
        const text = await service!.readFile(snap!, relPath, normalizeScope());
        return {
          kind: "json",
          status: 200,
          body: { sourceId, path: relPath, text },
        };
      },
    },
  };
  registerRouteModule(generations);

  server = await startStubServer({
    module: {
      id: "projects",
      routes: [ANALYSES_ROUTE],
      handlers: {
        "analyses.create": () => async (req) => {
          analysesCalls += 1;
          const body = req.body as {
            ref?: string;
            scope?: Parameters<typeof normalizeScope>[0];
          };
          const resolvedSha = await service!.resolve(
            fixture!.repo.repoId,
            body.ref ?? "",
          );
          const scope = normalizeScope(body.scope);
          return {
            kind: "json",
            status: 202,
            body: {
              jobId: "j_integration",
              resolvedSha,
              scopeHash: scope.hash,
              scope,
            },
          };
        },
      },
    },
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (harness !== undefined) {
    restoreWritable(harness.paths.work);
    harness.close();
  }
  harness = undefined;
  fixture = undefined;
  snap = undefined;
  service = undefined;
});

function request(options: StubRequestOptions) {
  return httpRequest(server!.port, {
    ...options,
    headers: { ...server!.cookie, ...(options.headers ?? {}) },
  });
}

function postAnalyses(body: string) {
  return request({
    method: "POST",
    path: "/api/projects/p_1/analyses",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function errorOf(body: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const parsed = body as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  expect(Object.keys(parsed)).toEqual(["error"]);
  expect(typeof parsed.error.code).toBe("string");
  expect(typeof parsed.error.message).toBe("string");
  return parsed.error;
}

describe("ref resolution and scope normalization across the HTTP boundary", () => {
  it("resolves a full SHA and reports the default scope hash", async () => {
    const response = await postAnalyses(JSON.stringify({ ref: fixture!.sha }));
    expect(response.status).toBe(202);
    const body = jsonBody(response) as {
      resolvedSha: string;
      scopeHash: string;
      scope: { include: string[]; exclude: string[] };
    };
    expect(body.resolvedSha).toBe(fixture!.sha);
    expect(body.scopeHash).toBe(normalizeScope().hash);
    expect(body.scope.include).toEqual(normalizeScope().include);
    expect(body.scope.exclude).toEqual(normalizeScope().exclude);
  });

  it("resolves a branch name to the same commit (AC-PRJ-08)", async () => {
    const response = await postAnalyses(JSON.stringify({ ref: "HEAD" }));
    expect(response.status).toBe(202);
    expect((jsonBody(response) as { resolvedSha: string }).resolvedSha).toBe(
      fixture!.sha,
    );
  });

  it("maps an unknown ref to 400 invalid_input/unknown_ref", async () => {
    const response = await postAnalyses(
      JSON.stringify({ ref: "no-such-branch" }),
    );
    expect(response.status).toBe(400);
    const error = errorOf(jsonBody(response));
    expect(error.code).toBe("invalid_input");
    expect(error.details).toMatchObject({
      reason: "unknown_ref",
      ref: "no-such-branch",
    });
  });

  it("hashes the same logical scope identically regardless of pattern order", async () => {
    const first = await postAnalyses(
      JSON.stringify({
        ref: fixture!.sha,
        scope: { include: ["src/**", "README.md"], exclude: ["dist/**"] },
      }),
    );
    const second = await postAnalyses(
      JSON.stringify({
        ref: fixture!.sha,
        scope: { include: ["README.md", "src/**"], exclude: ["dist/**"] },
      }),
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = jsonBody(first) as { scopeHash: string };
    const b = jsonBody(second) as { scopeHash: string };
    expect(a.scopeHash).toBe(b.scopeHash);
    expect(a.scopeHash).not.toBe(normalizeScope().hash);
  });

  it("rejects an unknown scope key with an invalid_input issue path", async () => {
    const before = analysesCalls;
    const response = await postAnalyses(
      JSON.stringify({ ref: fixture!.sha, scope: { include: ["src/**"], nope: 1 } }),
    );
    expect(response.status).toBe(400);
    const error = errorOf(jsonBody(response));
    expect(error.code).toBe("invalid_input");
    const issues = error.details?.issues as { path: string }[];
    expect(Array.isArray(issues)).toBe(true);
    expect(issues[0]?.path.startsWith("scope")).toBe(true);
    expect(analysesCalls).toBe(before);
  });

  it("rejects a malformed JSON body before the handler runs", async () => {
    const before = analysesCalls;
    const response = await postAnalyses('{"ref":');
    expect(response.status).toBe(400);
    const error = errorOf(jsonBody(response));
    expect(error.code).toBe("invalid_input");
    expect(error.details).toMatchObject({ problem: "malformed_json" });
    expect(analysesCalls).toBe(before);
  });
});

describe("projects errors keep their HTTP meaning", () => {
  it("serves an in-scope snapshot file through the source route", async () => {
    const response = await request({
      path: "/api/generations/g_1/sources/app",
    });
    expect(response.status).toBe(200);
    const body = jsonBody(response) as { path: string; text: string };
    expect(body.path).toBe("src/app.py");
    const expected = fs.readFileSync(
      path.join(snap!.worktreePath, "src/app.py"),
      "utf8",
    );
    expect(body.text).toBe(expected);
  });

  it("refuses a secret file with 403 out_of_scope_path and leaks no bytes", async () => {
    const response = await request({
      path: "/api/generations/g_1/sources/env",
    });
    expect(response.status).toBe(403);
    const error = errorOf(jsonBody(response));
    expect(error.code).toBe("out_of_scope_path");
    expect(error.details).toMatchObject({ path: ".env" });
    expect(response.text).not.toContain(CANARY);
    expect(response.text).not.toContain(harness!.paths.root);
  });

  it("maps a missing in-scope file to 404 not_found", async () => {
    const response = await request({
      path: "/api/generations/g_1/sources/missing",
    });
    expect(response.status).toBe(404);
    const error = errorOf(jsonBody(response));
    expect(error.code).toBe("not_found");
    expect(error.details).toMatchObject({ path: "missing.py" });
  });

  it("maps an unexpected handler throw to a generic 500 with no leak", async () => {
    const response = await request({
      path: "/api/generations/g_1/sources/boom",
    });
    expect(response.status).toBe(500);
    const error = errorOf(jsonBody(response));
    expect(error.code).toBe("internal_error");
    expect(response.text).not.toContain("boom");
    expect(response.text).not.toContain("/Users/");
    expect(response.text).not.toContain(harness!.paths.root);
  });
});
