import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionStore,
  SESSION_COOKIE,
  SESSION_TOKEN_BYTES,
  type SessionStore,
} from "../../../src/learning/api/auth.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import { createTempDataDir } from "../setup/tmp-data-dir.ts";
import {
  cookieToken,
  request,
  startAuthHarness,
  type AuthHarness,
} from "../helpers/auth-server.ts";

/**
 * Session token properties (AC-SEC-04).
 *
 * 32 random bytes, persisted at 0600, delivered as
 * `HttpOnly; SameSite=Strict`, compared in constant time and never echoed in a
 * response body.
 */

function currentPaths(): DataPaths {
  return resolveDataPaths(process.env);
}

function fileMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("token generation and persistence", () => {
  it("creates 32 random bytes as 64 hex characters", async () => {
    const store = createSessionStore(currentPaths());
    const token = await store.ensureToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(Buffer.from(token, "hex")).toHaveLength(SESSION_TOKEN_BYTES);
    expect(SESSION_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
  });

  it("returns the same token on every call", async () => {
    const store = createSessionStore(currentPaths());
    const first = await store.ensureToken();
    const second = await store.ensureToken();
    expect(second).toBe(first);
  });

  it("generates independent tokens for independent data roots", async () => {
    const store = createSessionStore(currentPaths());
    const token = await store.ensureToken();

    const other = createTempDataDir("codetrail-auth-");
    try {
      const otherStore = createSessionStore(resolveDataPaths(other.env));
      expect(await otherStore.ensureToken()).not.toBe(token);
    } finally {
      other.cleanup();
    }
  });

  it("persists session.json with mode 0600", async () => {
    const paths = currentPaths();
    const store = createSessionStore(paths);
    const token = await store.ensureToken();

    expect(fs.existsSync(paths.session)).toBe(true);
    expect(fileMode(paths.session)).toBe(0o600);

    const stored = JSON.parse(fs.readFileSync(paths.session, "utf8")) as {
      token?: unknown;
    };
    expect(stored.token).toBe(token);
  });

  it("keeps the token when reloading from disk", async () => {
    const paths = currentPaths();
    const first = await createSessionStore(paths).ensureToken();
    const second = await createSessionStore(paths).ensureToken();
    expect(second).toBe(first);
  });

  it("repairs a pre-existing 0644 session.json without rotating the token", async () => {
    const paths = currentPaths();
    const original = await createSessionStore(paths).ensureToken();
    fs.chmodSync(paths.session, 0o644);
    expect(fileMode(paths.session)).toBe(0o644);

    const reloaded = createSessionStore(paths);
    // The constructor repairs the mode before any request reaches the store.
    expect(fileMode(paths.session)).toBe(0o600);
    expect(await reloaded.ensureToken()).toBe(original);
    expect(fileMode(paths.session)).toBe(0o600);
  });

  it("regenerates a corrupt session.json at 0600", async () => {
    const paths = currentPaths();
    fs.writeFileSync(paths.session, "{ this is not json", { mode: 0o600 });

    const token = await createSessionStore(paths).ensureToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(fileMode(paths.session)).toBe(0o600);
  });

  it("regenerates an empty session.json at 0600", async () => {
    const paths = currentPaths();
    fs.writeFileSync(paths.session, "", { mode: 0o600 });

    const token = await createSessionStore(paths).ensureToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(fileMode(paths.session)).toBe(0o600);
  });

  it("re-creates session.json when it was deleted after construction", async () => {
    const paths = currentPaths();
    const store = createSessionStore(paths);
    const token = await store.ensureToken();
    fs.rmSync(paths.session);

    expect(await store.ensureToken()).toBe(token);
    expect(fs.existsSync(paths.session)).toBe(true);
    expect(fileMode(paths.session)).toBe(0o600);
  });
});

describe("constant-time verification", () => {
  let store: SessionStore;
  let token: string;

  async function ready(): Promise<void> {
    store = createSessionStore(currentPaths());
    token = await store.ensureToken();
  }

  it("accepts only the exact token", async () => {
    await ready();
    expect(store.verify(token)).toBe(true);
  });

  it("rejects missing, empty, short, long and wrong candidates", async () => {
    await ready();
    expect(store.verify(undefined)).toBe(false);
    expect(store.verify("")).toBe(false);
    expect(store.verify(token.slice(0, 32))).toBe(false);
    expect(store.verify(`${token}00`)).toBe(false);
    expect(store.verify(token.toUpperCase())).toBe(false);
    expect(store.verify("0".repeat(64))).toBe(false);
  });

  it("rejects everything before a token exists", () => {
    const fresh = createSessionStore(currentPaths());
    expect(fresh.verify("0".repeat(64))).toBe(false);
    expect(fresh.verify(undefined)).toBe(false);
  });
});

describe("cookie attributes", () => {
  it("sets HttpOnly, SameSite=Strict and Path=/, and never embeds attributes in the value", async () => {
    const store = createSessionStore(currentPaths());
    const token = await store.ensureToken();
    const header = store.cookieHeader(token);

    expect(header).toBe(
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    );
    expect(header.startsWith(`${SESSION_COOKIE}=${token};`)).toBe(true);
  });

  it("clears the cookie without revealing a token", () => {
    const store = createSessionStore(currentPaths());
    const header = store.clearCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
  });
});

describe("the token never reaches an HTTP body", () => {
  let harness: AuthHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  it("is absent from landing, bootstrap, health, guarded and error bodies", async () => {
    harness = await startAuthHarness();
    const token = await harness.store.ensureToken();

    const bootstrap = await request(harness.port, {
      path: "/session/bootstrap",
    });
    expect(cookieToken(bootstrap.headers)).toBe(token);

    const responses = [
      await request(harness.port, { path: "/" }),
      bootstrap,
      await request(harness.port, { path: "/api/health" }),
      await request(harness.port, { path: "/api/projects" }),
      await request(harness.port, {
        path: "/api/projects",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      await request(harness.port, {
        method: "POST",
        path: "/api/projects",
        headers: {
          Cookie: `${SESSION_COOKIE}=${token}`,
          Origin: "http://evil.example",
        },
      }),
    ];

    for (const response of responses) {
      expect(response.text).not.toContain(token);
    }
  });
});
