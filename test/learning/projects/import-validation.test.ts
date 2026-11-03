import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePath } from "../helpers/git-fixture.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  type StubResponse,
} from "../helpers/stub-server.ts";
import { startRoutesHarness, type RoutesHarness } from "./routes-harness.ts";

/**
 * AC-PRJ-02: invalid import bodies stay distinct — a non-Git directory is
 * `invalid_input` + `details.reason="not_git_repo"`, a missing path is
 * `invalid_path`, a relative path and a two-source body are both 400 — and
 * every failure body is `{error:{code,message,...}}`, never an empty 200.
 */

let server: RoutesHarness | undefined;

beforeEach(async () => {
  server = await startRoutesHarness();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function post(body: unknown): Promise<StubResponse> {
  return httpRequest(server!.port, {
    method: "POST",
    path: "/api/projects",
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function scratch(name: string): string {
  const dir = path.join(server!.paths.root, "scratch", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("import validation", () => {
  it("maps non-Git, missing, relative and both-source bodies to distinct errors", async () => {
    const plain = scratch("plain");
    fs.writeFileSync(path.join(plain, "README.md"), "# not a repo\n");

    const nonGit = await post({ localPath: plain });
    expect(nonGit.status).toBe(400);
    expect(errorCode(nonGit)).toBe("invalid_input");
    expect(
      (jsonBody(nonGit) as { error: { details?: { reason?: string } } }).error
        .details?.reason,
    ).toBe("not_git_repo");

    const missing = await post({
      localPath: path.join(plain, "does-not-exist"),
    });
    expect(missing.status).toBe(400);
    expect(errorCode(missing)).toBe("invalid_path");

    const relative = await post({ localPath: "relative/path" });
    expect(relative.status).toBe(400);
    expect(errorCode(relative)).toBe("invalid_input");

    const both = await post({
      localPath: fixturePath("last-mile-mini"),
      githubUrl: "https://github.com/acme/widgets",
    });
    expect(both.status).toBe(400);
    expect(errorCode(both)).toBe("invalid_input");

    const empty = await post({});
    expect(empty.status).toBe(400);
    expect(errorCode(empty)).toBe("invalid_input");

    for (const response of [nonGit, missing, relative, both, empty]) {
      expect(response.status).not.toBe(200);
      const body = jsonBody(response) as {
        error?: { code?: unknown; message?: unknown };
      };
      expect(body.error?.code).toBeTypeOf("string");
      expect(body.error?.message).toBeTypeOf("string");
    }
  });

  it("never creates a project for a rejected import", async () => {
    const plain = scratch("plain-2");
    await post({ localPath: plain });
    expect(server!.repos.projects.list()).toEqual([]);
    expect(server!.repos.repos.byIdentity(`local:${plain}` as never)).toBeNull();
  });
});
