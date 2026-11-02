import { afterEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../../../src/learning/api/auth.ts";
import {
  cookieToken,
  request,
  startAuthHarness,
  type AuthHarness,
  type HttpResponse,
} from "../helpers/auth-server.ts";

/**
 * Session wiring on a real port-0 listener (AC-API-02, AC-SEC-04).
 *
 * The guard server mirrors the middleware chain of `api/server.ts`, which is a
 * later wave: every route except `GET /api/health` fails closed with 401 until
 * a valid session cookie is presented.
 */

let harness: AuthHarness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

async function start(): Promise<AuthHarness> {
  harness = await startAuthHarness();
  return harness;
}

function errorCode(response: HttpResponse): unknown {
  const parsed = JSON.parse(response.text) as {
    error?: { code?: string };
  };
  return parsed.error?.code;
}

function cookieHeader(token: string): Record<string, string> {
  return { Cookie: `${SESSION_COOKIE}=${token}` };
}

describe("/api routes require a valid session", () => {
  it("serves /api/health without a credential", async () => {
    const server = await start();
    const response = await request(server.port, { path: "/api/health" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ status: "ok" });
  });

  it("rejects an unauthenticated /api request with 401 unauthorized", async () => {
    const server = await start();
    const response = await request(server.port, { path: "/api/projects" });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("unauthorized");
  });

  it("rejects a wrong token with 401", async () => {
    const server = await start();
    const response = await request(server.port, {
      path: "/api/projects",
      headers: { Cookie: `${SESSION_COOKIE}=${"0".repeat(64)}` },
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("unauthorized");
  });

  it("rejects an empty cookie value with 401", async () => {
    const server = await start();
    const response = await request(server.port, {
      path: "/api/projects",
      headers: { Cookie: `${SESSION_COOKIE}=` },
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("unauthorized");
  });

  it("accepts the token minted by /session/bootstrap", async () => {
    const server = await start();
    const bootstrap = await request(server.port, {
      path: "/session/bootstrap",
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.text).toBe("");

    const token = cookieToken(bootstrap.headers);
    expect(token).not.toBeNull();

    const response = await request(server.port, {
      path: "/api/projects",
      headers: cookieHeader(token as string),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ path: "/api/projects" });
  });

  it("fails closed on every /api path except health", async () => {
    const server = await start();
    for (const path of ["/api/jobs", "/api/preferences", "/api/usage"]) {
      const response = await request(server.port, { path });
      expect(response.status, path).toBe(401);
      expect(errorCode(response), path).toBe("unauthorized");
    }
  });

  it("checks Host before the session: a bad Host is 403 even with a valid cookie", async () => {
    const server = await start();
    const token = await server.store.ensureToken();
    const response = await request(server.port, {
      path: "/api/projects",
      headers: { ...cookieHeader(token), Host: `evil.example:${server.port}` },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("forbidden_origin");
  });
});

describe("session cookie minting", () => {
  it("mints the cookie on GET / without leaking the token in the body", async () => {
    const server = await start();
    const response = await request(server.port, { path: "/" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");

    const token = cookieToken(response.headers);
    expect(token).not.toBeNull();
    expect(response.text).not.toContain(token as string);
    expect(response.text).not.toContain(SESSION_COOKIE);
  });

  it("mints the cookie on GET /session/bootstrap with an empty body", async () => {
    const server = await start();
    const response = await request(server.port, { path: "/session/bootstrap" });
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
    expect(cookieToken(response.headers)).not.toBeNull();
  });

  it("accepts the cookie on a state-changing same-origin request", async () => {
    const server = await start();
    const token = await server.store.ensureToken();
    const response = await request(server.port, {
      method: "POST",
      path: "/api/projects",
      headers: {
        ...cookieHeader(token),
        Origin: `http://127.0.0.1:${server.port}`,
      },
    });
    expect(response.status).toBe(200);
  });

  it("checks Origin before the session: cross-site POST is 403, not 401", async () => {
    const server = await start();
    const response = await request(server.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Origin: "http://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe("forbidden_origin");
  });

  it("401 is the answer for a same-origin POST without a cookie", async () => {
    const server = await start();
    const response = await request(server.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Origin: `http://localhost:${server.port}` },
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("unauthorized");
  });
});

describe("the token never appears in a response body", () => {
  it("scans every public, guarded and error body", async () => {
    const server = await start();
    const token = await server.store.ensureToken();
    const goodCookie = cookieHeader(token);

    const responses: HttpResponse[] = [
      await request(server.port, { path: "/" }),
      await request(server.port, { path: "/session/bootstrap" }),
      await request(server.port, { path: "/api/health" }),
      await request(server.port, { path: "/api/projects" }),
      await request(server.port, {
        path: "/api/projects",
        headers: goodCookie,
      }),
      await request(server.port, {
        path: "/api/projects",
        headers: { Cookie: `${SESSION_COOKIE}=${"f".repeat(64)}` },
      }),
      await request(server.port, {
        method: "POST",
        path: "/api/projects",
        headers: { ...goodCookie, Origin: "http://evil.example" },
      }),
      await request(server.port, {
        path: "/api/projects",
        headers: { ...goodCookie, Host: `evil.example:${server.port}` },
      }),
    ];

    for (const response of responses) {
      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain(`=${token}`);
    }
  });
});
