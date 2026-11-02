import { spawnSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OfflineViolationError,
  isLoopbackHost,
  offlineGuardInstalled,
} from "../setup/guard.ts";
import { createTempDataDir, defaultDataDir } from "../setup/tmp-data-dir.ts";
import {
  startFakeGithub,
  type FakeGithub,
  type FakeGithubOptions,
} from "../helpers/fake-github.ts";
import { startHarness } from "../helpers/http-client.ts";

/**
 * Offline guard, data-directory isolation, fake GitHub and the two scanners
 * (PRD §15.1/§15.2, architecture §17.1/§17.2).
 *
 * The guard must fail closed: every patched client API throws for a
 * non-loopback target, and a real external fetch is the proof. Loopback test
 * servers must keep working, otherwise the rest of the suite could not run.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function runScript(
  script: string,
  args: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", script), ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
}

describe("offline guard", () => {
  it("is installed by the setup file", () => {
    expect(offlineGuardInstalled()).toBe(true);
  });

  it("classifies loopback and non-loopback hosts", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "localhost",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      undefined,
      "",
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(true);
    }
    for (const host of [
      "example.com",
      "10.0.0.1",
      "0.0.0.0",
      "api.github.com",
      "192.168.1.1",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("blocks a real external fetch", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(
      OfflineViolationError,
    );
    await expect(fetch("http://api.github.com/repos/x/y")).rejects.toThrow(
      /offline_guard/,
    );
  });

  it("blocks fetch with an unparseable target (fail closed)", async () => {
    await expect(fetch("not a url")).rejects.toThrow(OfflineViolationError);
  });

  it("blocks http.request and https.request to a non-loopback host", () => {
    expect(() => http.request("http://example.com/")).toThrow(
      OfflineViolationError,
    );
    expect(() => http.request({ hostname: "example.com", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => http.request({ host: "example.com:80", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => http.get("http://example.com/")).toThrow(
      OfflineViolationError,
    );
    expect(() => https.request("https://example.com/")).toThrow(
      OfflineViolationError,
    );
    expect(() => https.get({ hostname: "example.com", port: 443 })).toThrow(
      OfflineViolationError,
    );
  });

  it("blocks net.connect, net.createConnection and tls.connect", () => {
    expect(() => net.connect({ host: "example.com", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => net.connect(80, "example.com")).toThrow(OfflineViolationError);
    expect(() =>
      net.createConnection({ host: "example.com", port: 80 }),
    ).toThrow(OfflineViolationError);
    expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(
      OfflineViolationError,
    );
  });

  it("blocks dns.lookup and dns.promises.lookup for non-loopback names", async () => {
    expect(() => dns.lookup("example.com", () => {})).toThrow(
      OfflineViolationError,
    );
    await expect(dns.promises.lookup("example.com")).rejects.toThrow(
      OfflineViolationError,
    );
  });

  it("still allows loopback servers", async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address() as AddressInfo;
    const port = address.port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");

      const viaHttp = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          { hostname: "127.0.0.1", port, path: "/" },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += String(chunk);
            });
            res.on("end", () => resolve(body));
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(viaHttp).toBe("ok");

      const socket = net.connect({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("error", reject);
      });
      socket.destroy();

      const lookup = await dns.promises.lookup("localhost");
      expect(lookup.address).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("offline guard fail-closed edge cases", () => {
  it("blocks non-loopback IPv6, wildcard and subdomain targets", () => {
    expect(() => http.request({ hostname: "2001:db8::1", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => http.request({ hostname: "0.0.0.0", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => net.connect({ host: "[2001:db8::1]", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => net.connect({ host: "0.0.0.0", port: 80 })).toThrow(
      OfflineViolationError,
    );
    expect(() => tls.connect(443, "example.com")).toThrow(
      OfflineViolationError,
    );
    expect(() => dns.lookup("localhost.evil.com", () => {})).toThrow(
      OfflineViolationError,
    );
  });

  it("blocks URL userinfo tricks that hide a non-loopback hostname", async () => {
    await expect(fetch("http://127.0.0.1@example.com/")).rejects.toThrow(
      OfflineViolationError,
    );
    expect(() => http.request("http://127.0.0.1@example.com/")).toThrow(
      OfflineViolationError,
    );
  });

  it("blocks a Request object whose URL is non-loopback", async () => {
    await expect(fetch(new Request("https://example.com/"))).rejects.toThrow(
      OfflineViolationError,
    );
  });

  it("blocks unparseable request targets instead of letting them through", () => {
    expect(() => http.request("not a url")).toThrow(OfflineViolationError);
  });

  it("throws a typed error carrying the blocked kind and target", () => {
    try {
      http.request({ hostname: "api.github.com", port: 443 });
      expect.unreachable("the guard did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OfflineViolationError);
      const violation = error as OfflineViolationError;
      expect(violation.code).toBe("offline_violation");
      expect(violation.kind).toBe("http.request");
      expect(violation.target).toBe("api.github.com");
    }
  });
});

describe("temporary data directory", () => {
  let seen: string | null = null;

  it("points CODETRAIL_DATA_DIR at a fresh directory per test", () => {
    const dir = process.env.CODETRAIL_DATA_DIR;
    expect(dir).toBeTruthy();
    expect(dir).not.toBe(defaultDataDir());
    expect(fs.statSync(dir as string).isDirectory()).toBe(true);
    expect(seen).toBeNull();
    seen = dir as string;
  });

  it("gives the next test a different directory", () => {
    const dir = process.env.CODETRAIL_DATA_DIR;
    expect(dir).toBeTruthy();
    expect(dir).not.toBe(seen);
  });

  it("creates and removes independent data directories on demand", () => {
    const temp = createTempDataDir();
    expect(fs.existsSync(temp.dir)).toBe(true);
    expect(temp.env.CODETRAIL_DATA_DIR).toBe(temp.dir);
    expect(temp.dir).not.toBe(process.env.CODETRAIL_DATA_DIR);
    temp.cleanup();
    expect(fs.existsSync(temp.dir)).toBe(false);
  });

  it("keeps the directory under the OS temp root and removes it afterwards", () => {
    const dir = process.env.CODETRAIL_DATA_DIR as string;
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    // `seen` is the first test's directory; its afterEach already removed it.
    expect(seen).toBeTruthy();
    expect(fs.existsSync(seen as string)).toBe(false);
  });
});

describe("fake GitHub", () => {
  let servers: FakeGithub[] = [];

  async function start(
    options: Partial<FakeGithubOptions> = {},
  ): Promise<FakeGithub> {
    const server = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 3,
      perPage: 2,
      ...options,
    });
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    for (const server of servers) await server.close();
    servers = [];
  });

  it("pages with Link headers and sorts state=all by updated descending", async () => {
    const server = await start();
    const first = await fetch(
      `${server.baseUrl}/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=2&page=1`,
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as Array<{ number: number }>;
    expect(firstPage.map((pr) => pr.number)).toEqual([1, 2]);
    const link = first.headers.get("link") ?? "";
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
    expect(link).toContain("page=2");

    const last = await fetch(
      `${server.baseUrl}/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=2&page=3`,
    );
    const lastPage = (await last.json()) as Array<{ number: number }>;
    expect(lastPage.map((pr) => pr.number)).toEqual([5, 6]);
    expect(last.headers.get("link") ?? "").toContain('rel="prev"');
    expect(last.headers.get("link") ?? "").not.toContain('rel="next"');
  });

  it("serves rate-limit headers and records every request", async () => {
    const server = await start({
      rateLimit: { remaining: 42, resetAt: "2024-06-01T00:10:00Z" },
    });
    const response = await fetch(`${server.baseUrl}/repos/acme/widgets`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("5000");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("42");
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "2024-06-01T00:10:00Z",
    );
    expect(response.headers.get("x-ratelimit-used")).toBe("4958");

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toEqual({
      method: "GET",
      path: "/repos/acme/widgets",
    });
  });

  it("injects a 429 with Retry-After, then serves normally", async () => {
    const server = await start({ failFirst: 1, retryAfter: 7 });
    const first = await fetch(`${server.baseUrl}/repos/acme/widgets`);
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("7");
    const second = await fetch(`${server.baseUrl}/repos/acme/widgets`);
    expect(second.status).toBe(200);
  });

  it("injects 5xx failures", async () => {
    const server = await start({ failFirst: 2 });
    expect((await fetch(`${server.baseUrl}/repos/acme/widgets`)).status).toBe(
      500,
    );
    expect((await fetch(`${server.baseUrl}/repos/acme/widgets`)).status).toBe(
      500,
    );
    expect((await fetch(`${server.baseUrl}/repos/acme/widgets`)).status).toBe(
      200,
    );
  });

  it("serves a missing object as 404", async () => {
    const server = await start({ missingObjects: ["pulls/2"] });
    expect(
      (await fetch(`${server.baseUrl}/repos/acme/widgets/pulls/1`)).status,
    ).toBe(200);
    expect(
      (await fetch(`${server.baseUrl}/repos/acme/widgets/pulls/2`)).status,
    ).toBe(404);
  });

  it("truncates the compare file list at 300", async () => {
    const server = await start({ compareFiles: 320 });
    const response = await fetch(
      `${server.baseUrl}/repos/acme/widgets/compare/main...feature-1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      files: unknown[];
      truncated: boolean;
      total_commits: number;
    };
    expect(body.files).toHaveLength(300);
    expect(body.truncated).toBe(true);
    expect(body.total_commits).toBe(320);
  });

  it("enforces the token gate", async () => {
    const server = await start({ token: "s3cret" });
    expect((await fetch(`${server.baseUrl}/repos/acme/widgets`)).status).toBe(
      401,
    );
    const authorized = await fetch(`${server.baseUrl}/repos/acme/widgets`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(authorized.status).toBe(200);
  });

  it("records write methods instead of silently accepting them", async () => {
    const server = await start();
    const response = await fetch(`${server.baseUrl}/repos/acme/widgets/pulls`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(405);
    expect(server.requests.at(-1)).toEqual({
      method: "POST",
      path: "/repos/acme/widgets/pulls",
    });
    expect(server.requests.some((entry) => entry.method !== "GET")).toBe(true);
  });

  it("mutates branches for push, force-push and branch renames", async () => {
    const server = await start();
    const before = (await (
      await fetch(`${server.baseUrl}/repos/acme/widgets`)
    ).json()) as {
      default_branch: string;
    };
    expect(before.default_branch).toBe("main");

    server.pushCommit("a".repeat(40));
    const afterPush = (await (
      await fetch(`${server.baseUrl}/repos/acme/widgets/branches/main`)
    ).json()) as { commit: { sha: string } };
    expect(afterPush.commit.sha).toBe("a".repeat(40));

    server.forcePush("feature-open", "b".repeat(40));
    const forced = (await (
      await fetch(`${server.baseUrl}/repos/acme/widgets/branches/feature-open`)
    ).json()) as { commit: { sha: string } };
    expect(forced.commit.sha).toBe("b".repeat(40));

    server.renameDefaultBranch("trunk");
    const renamed = (await (
      await fetch(`${server.baseUrl}/repos/acme/widgets`)
    ).json()) as {
      default_branch: string;
    };
    expect(renamed.default_branch).toBe("trunk");
  });

  it("filters state=open/closed and honours direction=asc", async () => {
    const server = await start({ states: ["open", "closed", "merged"] });
    const numbers = async (query: string): Promise<number[]> => {
      const response = await fetch(
        `${server.baseUrl}/repos/acme/widgets/pulls?${query}`,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as Array<{ number: number }>).map(
        (pr) => pr.number,
      );
    };

    expect(
      await numbers("state=open&sort=updated&direction=desc&per_page=10"),
    ).toEqual([1, 4]);
    expect(
      await numbers("state=closed&sort=updated&direction=desc&per_page=10"),
    ).toEqual([2, 3, 5, 6]);
    expect(
      await numbers("state=all&sort=updated&direction=asc&per_page=10"),
    ).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("links first/prev/next/last on a middle page", async () => {
    const server = await start();
    const middle = await fetch(
      `${server.baseUrl}/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=2&page=2`,
    );
    const link = middle.headers.get("link") ?? "";
    for (const rel of ["first", "prev", "next", "last"]) {
      expect(link, rel).toContain(`rel="${rel}"`);
    }
  });

  it("does not mark a compare below the cap as truncated", async () => {
    const server = await start({ compareFiles: 5 });
    const response = await fetch(
      `${server.baseUrl}/repos/acme/widgets/compare/main...feature-1`,
    );
    const body = (await response.json()) as {
      files: unknown[];
      truncated: boolean;
      total_commits: number;
    };
    expect(body.files).toHaveLength(5);
    expect(body.truncated).toBe(false);
    expect(body.total_commits).toBe(5);
  });

  it("records query strings and HEAD requests", async () => {
    const server = await start();
    await fetch(
      `${server.baseUrl}/repos/acme/widgets/pulls?state=all&per_page=2`,
      { method: "HEAD" },
    );
    const recorded = server.requests.at(-1);
    expect(recorded?.method).toBe("HEAD");
    expect(recorded?.path).toContain("state=all");
    expect(recorded?.path).toContain("per_page=2");
  });
});

describe("loopback HTTP harness", () => {
  it("mints the session cookie and attaches it to later requests", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/session/bootstrap") {
        response.writeHead(204, {
          "Set-Cookie": "codetrail_session=abc123; HttpOnly; SameSite=Strict",
        });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? null }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;
    const harness = await startHarness({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      const response = await harness.request("/api/health");
      expect(response.status).toBe(200);
      expect(harness.sessionToken).toBe("abc123");
      expect((response.json as { cookie: string }).cookie).toContain(
        "codetrail_session=abc123",
      );
    } finally {
      await harness.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("copy scanner", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-scan-copy-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, content: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  it("reports path:line and exits non-zero on a forbidden phrase", () => {
    write("src/learning/ui/page.ts", "export const copy = '已证明全部正确';\n");
    const result = runScript("scan-copy.mjs", [
      "--root",
      root,
      "--forbid",
      "已证明全部正确",
    ]);
    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain("src/learning/ui/page.ts:1:");
  });

  it("exits 0 on a clean tree", () => {
    write("src/learning/ui/page.ts", "export const copy = '已核对';\n");
    expect(
      runScript("scan-copy.mjs", ["--root", root, "--forbid", "已证明全部正确"])
        .status,
    ).toBe(0);
  });

  it("scans schema identifiers separately from copy", () => {
    write(
      "src/learning/contracts/model.ts",
      "export interface Bad { mastery: number }\n",
    );
    const result = runScript("scan-copy.mjs", [
      "--root",
      root,
      "--forbid-in-schema",
      "mastery,proficiency,abilityScore,examScore",
    ]);
    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain(
      "src/learning/contracts/model.ts:1:",
    );
  });

  it("requires phrases and headings with a command block", () => {
    write(
      "README.md",
      "# Demo\n\n## 本地启动\n\n```bash\npnpm run start:learning\n```\n\n## 空章节\n\nnothing here\n",
    );
    expect(
      runScript("scan-copy.mjs", ["--root", root, "--require", "本地启动"])
        .status,
    ).toBe(0);
    const missing = runScript("scan-copy.mjs", [
      "--root",
      root,
      "--require",
      "轮询,force-push",
    ]);
    expect(missing.status).toBe(1);
    expect(String(missing.stdout)).toContain("missing required copy");

    expect(
      runScript("scan-copy.mjs", [
        "--root",
        root,
        "--require-headings",
        "## 本地启动",
      ]).status,
    ).toBe(0);
    const noCommand = runScript("scan-copy.mjs", [
      "--root",
      root,
      "--require-headings",
      "## 空章节",
    ]);
    expect(noCommand.status).toBe(1);
    expect(String(noCommand.stdout)).toContain("no executable command block");
  });

  it("excludes the UI and testing trees from schema-identifier scans", () => {
    write("src/learning/ui/panel.ts", "export const mastery = 1;\n");
    expect(
      runScript("scan-copy.mjs", [
        "--root",
        root,
        "--forbid-in-schema",
        "mastery",
      ]).status,
    ).toBe(0);

    const asCopy = runScript("scan-copy.mjs", [
      "--root",
      root,
      "--forbid",
      "mastery",
    ]);
    expect(asCopy.status).toBe(1);
    expect(String(asCopy.stdout)).toContain("src/learning/ui/panel.ts:1:");
  });

  it("reports a missing required heading", () => {
    write("README.md", "# Demo\n");
    const result = runScript("scan-copy.mjs", [
      "--root",
      root,
      "--require-headings",
      "## 不存在",
    ]);
    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain(
      'missing required heading "## 不存在"',
    );
  });

  it("skips binary files instead of scanning them as copy", () => {
    const file = path.join(root, "docs/model.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      Buffer.from([0x00, ...Buffer.from("已证明全部正确")]),
    );
    expect(
      runScript("scan-copy.mjs", ["--root", root, "--forbid", "已证明全部正确"])
        .status,
    ).toBe(0);
  });

  it("exits 2 on usage errors", () => {
    expect(runScript("scan-copy.mjs", ["--bogus"]).status).toBe(2);
    expect(runScript("scan-copy.mjs", ["--forbid"]).status).toBe(2);
  });
});

describe("code scanner", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-scan-code-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, content: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  it("reports path:line and exits non-zero on a forbidden pattern", () => {
    write("scripts/tool.mjs", 'exec("git push origin main");\n');
    const result = runScript("scan-code.mjs", [
      "--root",
      root,
      "--forbid-patterns",
      "git push",
    ]);
    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain("scripts/tool.mjs:1:");
  });

  it("exits 0 on a clean tree and on an empty root", () => {
    write("src/clean.ts", "export const value = 1;\n");
    expect(
      runScript("scan-code.mjs", [
        "--root",
        root,
        "--forbid-patterns",
        "git push",
      ]).status,
    ).toBe(0);
    const empty = fs.mkdtempSync(
      path.join(os.tmpdir(), "codetrail-scan-empty-"),
    );
    try {
      expect(
        runScript("scan-code.mjs", [
          "--root",
          empty,
          "--forbid-patterns",
          "git push",
        ]).status,
      ).toBe(0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("strips doc strings by default and restores them with --keep-comments", () => {
    write("src/doc.ts", "// a note about git push\nexport const value = 1;\n");
    expect(
      runScript("scan-code.mjs", [
        "--root",
        root,
        "--forbid-patterns",
        "git push",
      ]).status,
    ).toBe(0);
    const withComments = runScript("scan-code.mjs", [
      "--root",
      root,
      "--forbid-patterns",
      "git push",
      "--keep-comments",
    ]);
    expect(withComments.status).toBe(1);
    expect(String(withComments.stdout)).toContain("src/doc.ts:1:");
  });

  it("excludes the test tree by default and honours --include-tests and --exclude", () => {
    write("test/helper.ts", 'export const push = "git push";\n');
    write(
      "test/learning/helpers/fake-github.ts",
      'export const path = "pulls/1/comments";\n',
    );
    expect(
      runScript("scan-code.mjs", [
        "--root",
        root,
        "--forbid-patterns",
        "git push",
      ]).status,
    ).toBe(0);

    const included = runScript("scan-code.mjs", [
      "--root",
      root,
      "--forbid-patterns",
      "git push",
      "--include-tests",
    ]);
    expect(included.status).toBe(1);
    expect(String(included.stdout)).toContain("test/helper.ts:1:");

    const excluded = runScript("scan-code.mjs", [
      "--root",
      root,
      "--forbid-patterns",
      "pulls/.*/comments",
      "--roots",
      "test",
      "--include-tests",
      "--exclude",
      "test/learning/helpers/fake-github.ts",
    ]);
    expect(excluded.status).toBe(0);
  });

  it("passes on this repository with the documented patterns", () => {
    expect(
      runScript("scan-copy.mjs", ["--forbid", "已证明全部正确"]).status,
    ).toBe(0);
    expect(
      runScript("scan-code.mjs", ["--forbid-patterns", "git push"]).status,
    ).toBe(0);
  });

  it("skips binary source files", () => {
    const file = path.join(root, "src/blob.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from([0x00, ...Buffer.from("git push")]));
    expect(
      runScript("scan-code.mjs", [
        "--root",
        root,
        "--forbid-patterns",
        "git push",
      ]).status,
    ).toBe(0);
  });

  it("exits 2 on usage errors and invalid patterns", () => {
    expect(runScript("scan-code.mjs", ["--root", root]).status).toBe(2);
    expect(
      runScript("scan-code.mjs", ["--root", root, "--forbid-patterns"]).status,
    ).toBe(2);
    expect(
      runScript("scan-code.mjs", ["--root", root, "--forbid-patterns", "("])
        .status,
    ).toBe(2);
    expect(runScript("scan-code.mjs", ["--bogus"]).status).toBe(2);
  });

  it("terminates on a zero-length match pattern", () => {
    write("src/empty-match.ts", "export const value = 1;\n");
    const result = runScript("scan-code.mjs", [
      "--root",
      root,
      "--forbid-patterns",
      "^",
    ]);
    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain("src/empty-match.ts:1:");
  });
});
