import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "../../../src/learning/api/router.ts";
import {
  LearningError,
  type CoverageReport,
  type GenerationId,
  type NormalizedScope,
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
  errorCode,
  httpRequest,
  jsonBody,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * Integration: the merged projects-scope coverage report (`projects/coverage.ts`,
 * `projects/snapshot.ts`) served over the merged api-core HTTP surface
 * (`api/server.ts`, `api/router.ts`, `api/respond.ts`).
 *
 * The seam under test is generation-id → scope → snapshot → `CoverageReport`:
 * the HTTP layer must preserve the report's invariants (AC-PRJ-09/10/16) and
 * must not turn a not-fetched submodule or an out-of-scope path into a success.
 */

const COVERAGE_ROUTE = ROUTES.find(
  (route) => route.pattern === "/api/generations/:id/coverage",
);
if (COVERAGE_ROUTE === undefined) {
  throw new Error("coverage route missing from the frozen route table");
}

let harness: ProjectsHarness | undefined;
let fixture: ClonedFixture | undefined;
let snap: SnapshotRecord | undefined;
let service: SnapshotService | undefined;
let server: StubServer | undefined;
let handlerCalls = 0;
let scopes: Map<string, NormalizedScope>;

beforeEach(async () => {
  handlerCalls = 0;
  scopes = new Map<string, NormalizedScope>([
    ["g_default", normalizeScope()],
    [
      "g_narrow",
      normalizeScope({ include: ["src/**"], exclude: ["src/vendor/**"] }),
    ],
    ["g_limited", normalizeScope({ maxFiles: 1 })],
  ]);

  harness = await createHarness();
  fixture = await cloneFixture(harness, "scope-hygiene");
  service = createSnapshotService({
    paths: harness.paths,
    repos: harness.repos,
    clock: harness.clock,
  });
  snap = await service.ensure(fixture.repo.repoId, fixture.sha);

  const module: RouteModule = {
    id: "generations",
    routes: [COVERAGE_ROUTE],
    handlers: {
      "generations.coverage": () => async (req) => {
        handlerCalls += 1;
        const generationId = req.params.id ?? "";
        const scope = scopes.get(generationId);
        if (scope === undefined) {
          throw new LearningError("not_found", "生成版本不存在", {
            generationId,
          });
        }
        const report = await service!.coverage(
          snap!,
          scope,
          generationId as GenerationId,
        );
        return { kind: "json", status: 200, body: report };
      },
    },
  };
  server = await startStubServer({ module });
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

function get(
  path: string,
  headers: Record<string, string> = {},
): ReturnType<typeof httpRequest> {
  return httpRequest(server!.port, {
    path,
    headers: { ...server!.cookie, ...headers },
  });
}

async function coverageFor(generationId: string): Promise<{
  response: Awaited<ReturnType<typeof httpRequest>>;
  report: CoverageReport;
}> {
  const response = await get(`/api/generations/${generationId}/coverage`);
  expect(response.status, `GET coverage for ${generationId}`).toBe(200);
  return { response, report: jsonBody(response) as CoverageReport };
}

function expectErrorShape(body: unknown): { code: string; message: string } {
  expect(body, "error body must be an object").toMatchObject({
    error: expect.objectContaining({
      code: expect.any(String),
      message: expect.any(String),
    }),
  });
  const parsed = body as { error: { code: string; message: string } };
  expect(Object.keys(parsed), "error body has one top-level key").toEqual([
    "error",
  ]);
  return parsed.error;
}

describe("coverage over HTTP", () => {
  it("requires a session like every other non-public route", async () => {
    const before = handlerCalls;
    const anonymous = await httpRequest(server!.port, {
      path: "/api/generations/g_default/coverage",
    });
    expect(anonymous.status).toBe(401);
    expect(expectErrorShape(jsonBody(anonymous)).code).toBe("unauthorized");
    expect(handlerCalls).toBe(before);

    const authed = await get("/api/generations/g_default/coverage");
    expect(authed.status).toBe(200);
  });

  it("returns every excluded path with a path, a reason and bytes (AC-PRJ-09)", async () => {
    const { report } = await coverageFor("g_default");

    expect(report.generationId).toBe("g_default");
    expect(report.commitSha).toBe(fixture!.sha);
    expect(report.complete).toBe(false);
    expect(report.gaps.length).toBeGreaterThan(0);

    for (const gap of report.gaps) {
      expect(typeof gap.path, "gap path").toBe("string");
      expect(gap.path.length).toBeGreaterThan(0);
      expect(typeof gap.reason, "gap reason").toBe("string");
      expect(typeof gap.bytes, "gap bytes").toBe("number");
      expect(gap.bytes).toBeGreaterThanOrEqual(0);
    }

    const reasons = new Map(report.gaps.map((gap) => [gap.path, gap.reason]));
    expect(reasons.get(".env")).toBe("excluded_secret");
    expect(reasons.get("model.bin")).toBe("excluded_binary");
    expect(reasons.get("weights/model.pt")).toBe("excluded_binary");
    expect(reasons.get("dist/bundle.js")).toBe("excluded_default_dir");
    expect(reasons.get("node_modules/left-pad/index.js")).toBe(
      "excluded_default_dir",
    );
    expect(reasons.get("assets/model.lfs")).toBe("lfs_not_fetched");
    expect(reasons.get("vendor")).toBe("submodule_not_fetched");

    // Sorted, so rendering cannot reorder the report between requests.
    const paths = report.gaps.map((gap) => gap.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("derives complete only from its own gap list (AC-PRJ-16)", async () => {
    for (const generationId of scopes.keys()) {
      const { report } = await coverageFor(generationId);
      expect(report.complete, generationId).toBe(report.gaps.length === 0);
      expect(report.counts.analyzedFiles).toBe(report.analyzed.length);
      expect(report.counts.excludedFiles).toBe(report.gaps.length);
      expect(report.counts.totalFiles).toBe(
        report.analyzed.length + report.gaps.length,
      );
    }
  });

  it("propagates a narrowed include/exclude scope to the response (AC-PRJ-10)", async () => {
    const defaultHash = scopes.get("g_default")!.hash;
    const narrowHash = scopes.get("g_narrow")!.hash;
    expect(narrowHash).not.toBe(defaultHash);

    const { report: wide } = await coverageFor("g_default");
    const { report: narrow } = await coverageFor("g_narrow");

    expect(wide.analyzed.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([".gitmodules", "README.md", "src/app.py"]),
    );
    expect(narrow.analyzed.map((entry) => entry.path)).toEqual(["src/app.py"]);
    expect(narrow.gaps.find((gap) => gap.path === "README.md")?.reason).toBe(
      "excluded_by_scope",
    );
    expect(narrow.complete).toBe(false);

    // The same narrowed scope refuses reads outside the include list.
    await expect(
      service!.readFile(snap!, "README.md", scopes.get("g_narrow")!),
    ).rejects.toMatchObject({ code: "out_of_scope_path", status: 403 });
  });

  it("reports maxFiles overflow as gaps with the documented detail", async () => {
    const { report } = await coverageFor("g_limited");
    expect(report.analyzed).toHaveLength(1);
    const overflow = report.gaps.filter(
      (gap) => gap.detail === "max_files_exceeded",
    );
    expect(overflow.length).toBeGreaterThan(0);
    for (const gap of overflow) {
      expect(gap.reason).toBe("excluded_by_scope");
    }
    expect(report.counts.totalFiles).toBe(
      report.counts.analyzedFiles + report.counts.excludedFiles,
    );
  });

  it("maps an unknown generation to 404 not_found, never an empty 200", async () => {
    const response = await get("/api/generations/g_absent/coverage");
    expect(response.status).toBe(404);
    const error = expectErrorShape(jsonBody(response));
    expect(error.code).toBe("not_found");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("rejects a traversal-shaped generation id before the handler runs", async () => {
    for (const path of [
      "/api/generations/%2e%2e%2fetc/coverage",
      "/api/generations/%2Fetc%2Fpasswd/coverage",
      "/api/generations/..%5C..%5Csecret/coverage",
    ]) {
      const before = handlerCalls;
      const response = await get(path);
      expect([400, 403], path).toContain(response.status);
      expect(["out_of_scope_path", "invalid_input"], path).toContain(
        errorCode(response),
      );
      expect(handlerCalls, path).toBe(before);
      expect(response.text).not.toContain(harness!.paths.root);
    }
  });
});
