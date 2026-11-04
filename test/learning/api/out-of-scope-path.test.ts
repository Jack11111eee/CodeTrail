import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  errorCode,
  httpRequest,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * Out-of-scope path parameters are rejected by the router before any handler
 * (and therefore any filesystem call) runs (AC-API-05).
 */

let server: StubServer | null = null;
let sourceCalls = 0;
let projectCalls = 0;

beforeAll(async () => {
  sourceCalls = 0;
  projectCalls = 0;
  server = await startStubServer({
    handlers: {
      "generations.source": () => () => {
        sourceCalls += 1;
        return Promise.resolve({ kind: "json", status: 200, body: { ok: true } });
      },
      "projects.get": () => () => {
        projectCalls += 1;
        return Promise.resolve({ kind: "json", status: 200, body: { ok: true } });
      },
    },
  });
});

afterAll(async () => {
  await server?.close();
  server = null;
});

function get(path: string) {
  return httpRequest(server!.port, {
    path,
    headers: { ...server!.cookie },
  });
}

describe("path-like parameters never reach a handler", () => {
  const traversalPaths = [
    "/api/generations/g1/sources/..%2F..%2Fetc%2Fpasswd",
    "/api/generations/g1/sources/%2Fetc%2Fpasswd",
    "/api/generations/g1/sources/%2e%2e",
    "/api/projects/%2e%2e",
    "/api/projects/..%5C..%5Csecret",
    "/api/projects/%00hidden",
    "/api/generations/g1/sources/../../etc/passwd",
  ];

  for (const path of traversalPaths) {
    it(`rejects ${path}`, async () => {
      const before = sourceCalls + projectCalls;
      const response = await get(path);
      expect([400, 403]).toContain(response.status);
      expect(["out_of_scope_path", "invalid_input"]).toContain(
        errorCode(response),
      );
      expect(sourceCalls + projectCalls).toBe(before);
    });
  }

  it("does not leak the absolute data path in the rejection", async () => {
    const response = await get("/api/projects/%2e%2e");
    expect(response.text).not.toContain(server!.paths.root);
    expect(response.text).not.toContain("/Users/");
  });

  it("still serves an ordinary opaque id", async () => {
    const response = await get("/api/generations/g1/sources/src_1");
    expect(response.status).toBe(200);
    expect(sourceCalls).toBe(1);
  });
});
