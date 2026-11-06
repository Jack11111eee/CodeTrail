import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "../../../src/learning/api/router.ts";
import type {
  RouteModule,
  SnapshotReader,
  SnapshotRecord,
} from "../../../src/learning/contracts/index.ts";
import {
  assertReadable,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import { createSnapshotReader } from "../../../src/learning/projects/worktree.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * Integration: the two independent path guards merged in this round must agree.
 *
 * api-core rejects traversal-shaped *URL path parameters* before a route (and
 * therefore before any handler) runs (`api/server.ts` `assertSafeRawPath`,
 * `api/router.ts` `decodeParam`); projects-scope rejects relative reads through
 * `assertReadable`/`SnapshotReader` (`projects/scope.ts`, `projects/worktree.ts`).
 * A request may be stopped by either layer, but never by neither, and both must
 * use the same `out_of_scope_path` error vocabulary.
 */

const SOURCE_ROUTE = ROUTES.find(
  (route) => route.pattern === "/api/generations/:id/sources/:sourceId",
);
if (SOURCE_ROUTE === undefined) {
  throw new Error("source route missing from the frozen route table");
}

const API_CANARY = "ct-canary-do-not-leak-0001";
const OUTSIDE_CANARY = "ct-outside-canary-0002";

let root: string;
let outside: string;
let server: StubServer | undefined;
let calls = 0;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-sandbox-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-sandbox-out-"));
  write(path.join(root, "src/app.py"), 'print("hello")\n');
  write(path.join(root, ".env"), `CANARY_SECRET=${API_CANARY}\n`);
  write(path.join(outside, "secret.txt"), OUTSIDE_CANARY);
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
  fs.symlinkSync(path.join(root, "src/app.py"), path.join(root, "alias.txt"));

  calls = 0;
  const module: RouteModule = {
    id: "generations",
    routes: [SOURCE_ROUTE],
    handlers: {
      "generations.source": () => () => {
        calls += 1;
        return Promise.resolve({
          kind: "json",
          status: 200,
          body: { handlerReached: true },
        });
      },
    },
  };
  server = await startStubServer({ module });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function reader(): SnapshotReader {
  const record: SnapshotRecord = {
    repoId: "r_sandbox",
    commitSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    worktreePath: root,
    resolvedAt: "2026-01-01T00:00:00.000Z",
  } as SnapshotRecord;
  return createSnapshotReader(record, normalizeScope());
}

describe("API path parameters and scope paths reject the same shapes", () => {
  const hostile = [
    { url: "..%2F..%2Fetc%2Fpasswd", decoded: "../../etc/passwd" },
    { url: "%2Fetc%2Fpasswd", decoded: "/etc/passwd" },
    { url: "%2e%2e", decoded: ".." },
    { url: "..%5C..%5Csecret", decoded: "..\\..\\secret" },
    { url: "%00hidden", decoded: "\0hidden" },
    { url: "C%3A%5CWindows", decoded: "C:\\Windows" },
  ];

  for (const { url, decoded } of hostile) {
    it(`rejects ${decoded} at both layers`, async () => {
      const before = calls;
      const response = await httpRequest(server!.port, {
        path: `/api/generations/g_1/sources/${url}`,
        headers: { ...server!.cookie },
      });
      expect([400, 403], decoded).toContain(response.status);
      expect(["out_of_scope_path", "invalid_input"], decoded).toContain(
        errorCode(response),
      );
      expect(calls, "no handler may run for a hostile path").toBe(before);
      expect(response.text).not.toContain(root);
      expect(response.text).not.toContain(API_CANARY);

      let caught: unknown;
      try {
        assertReadable(decoded, normalizeScope(), root);
      } catch (error) {
        caught = error;
      }
      expect(caught, decoded).toMatchObject({
        code: "out_of_scope_path",
        status: 403,
      });
    });
  }

  it("still allows an opaque id and an ordinary in-scope read", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/generations/g_1/sources/s_1",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(200);
    expect(jsonBody(response)).toEqual({ handlerReached: true });
    expect(calls).toBe(1);

    expect(() =>
      assertReadable("src/app.py", normalizeScope(), root),
    ).not.toThrow();
    expect(await reader().read("src/app.py")).toBe('print("hello")\n');
  });
});

describe("SnapshotReader enforces realpath containment", () => {
  it("refuses a symlink that escapes the worktree root", async () => {
    const read = reader();
    await expect(read.read("escape.txt")).rejects.toMatchObject({
      code: "out_of_scope_path",
      status: 403,
      details: { reason: "symlink_escape" },
    });
    await expect(read.exists("escape.txt")).resolves.toBe(false);

    let leaked = "";
    try {
      await read.read("escape.txt");
    } catch (error) {
      const message = (error as { message?: string }).message;
      leaked = `${String(error)} ${message ?? ""}`;
    }
    expect(leaked).not.toContain(OUTSIDE_CANARY);
  });

  it("allows a symlink that stays inside the root", async () => {
    const read = reader();
    expect(await read.exists("alias.txt")).toBe(true);
    expect(await read.read("alias.txt")).toBe('print("hello")\n');
  });

  it("refuses an absolute path and a traversal before opening anything", async () => {
    const read = reader();
    await expect(
      read.read(path.join(outside, "secret.txt")),
    ).rejects.toMatchObject({ code: "out_of_scope_path" });
    await expect(read.read("../secret.txt")).rejects.toMatchObject({
      code: "out_of_scope_path",
    });
    await expect(read.read(".env")).rejects.toMatchObject({
      code: "out_of_scope_path",
    });
  });
});
