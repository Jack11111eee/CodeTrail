import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateProjectResponse } from "../../../src/learning/contracts/index.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  type StubResponse,
} from "../helpers/stub-server.ts";
import { startRoutesHarness, type RoutesHarness } from "./routes-harness.ts";

/**
 * AC-PRJ-03: `POST /api/projects` is the only route that accepts an absolute
 * filesystem path. Every other surface treats a path-shaped value as data and
 * rejects it before touching the filesystem (`403 out_of_scope_path` or
 * `400 invalid_input`), never as a repository location.
 */

let server: RoutesHarness | undefined;
let projectId: string;

beforeEach(async () => {
  server = await startRoutesHarness();
  const created = await httpRequest(server.port, {
    method: "POST",
    path: "/api/projects",
    headers: { ...server.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ localPath: fixturePath("last-mile-mini") }),
  });
  expect(created.status).toBe(201);
  projectId = (jsonBody(created) as CreateProjectResponse).projectId;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function get(path: string): Promise<StubResponse> {
  return httpRequest(server!.port, { path, headers: { ...server!.cookie } });
}

function post(path: string, body: unknown): Promise<StubResponse> {
  return httpRequest(server!.port, {
    method: "POST",
    path,
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("absolute path boundary", () => {
  it("rejects a path-shaped ref on the analyses route", async () => {
    const response = await post(`/api/projects/${projectId}/analyses`, {
      ref: "/etc/passwd",
    });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("out_of_scope_path");
  });

  it("rejects path-shaped ids on the generation reads", async () => {
    for (const path of [
      `/api/generations/${encodeURIComponent("/etc/passwd")}/lessons`,
      `/api/generations/gen_1/sources/${encodeURIComponent("/etc/passwd")}`,
      `/api/generations/${encodeURIComponent("../secrets")}/coverage`,
    ]) {
      const response = await get(path);
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe("out_of_scope_path");
    }
  });

  it("rejects extra path-like body fields on a submission", async () => {
    const response = await post(`/api/projects/${projectId}/analyses`, {
      ref: "HEAD",
      localPath: "/etc/passwd",
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("accepts the same absolute path only on the import route", async () => {
    // The successful import in `beforeEach` is the positive half: the same
    // absolute path is a valid `localPath`, while a ref is not.
    const accepted = await get("/api/projects");
    expect(accepted.status).toBe(200);
  });
});
