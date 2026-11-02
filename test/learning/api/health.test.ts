import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CODETRAIL_VERSION,
  UPSTREAM_COMMIT,
} from "../../../src/learning/config/defaults.ts";
import {
  jsonBody,
  httpRequest,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * `GET /api/health` is the one unauthenticated API route (AC-API-13).
 *
 * It reports the pinned version and upstream commit and must not leak a data
 * directory, a session token or any other absolute path.
 */

let server: StubServer | null = null;

beforeAll(async () => {
  server = await startStubServer();
});

afterAll(async () => {
  await server?.close();
  server = null;
});

describe("GET /api/health", () => {
  it("needs no credential and returns status, version and upstream commit", async () => {
    const response = await httpRequest(server!.port, { path: "/api/health" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(jsonBody(response)).toEqual({
      status: "ok",
      version: CODETRAIL_VERSION,
      upstreamCommit: UPSTREAM_COMMIT,
    });
  });

  it("leaks no absolute path or session token", async () => {
    const response = await httpRequest(server!.port, { path: "/api/health" });
    expect(response.text).not.toContain(server!.paths.root);
    expect(response.text).not.toContain(server!.paths.db);
    expect(response.text).not.toContain(server!.token);
    expect(response.text).not.toMatch(/\/Users\/|\/home\//u);
  });

  it("is public even when a bogus cookie is presented", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/health",
      headers: { Cookie: "codetrail_session=not-a-token" },
    });
    expect(response.status).toBe(200);
  });
});
