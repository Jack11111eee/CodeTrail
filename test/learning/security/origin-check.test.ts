import { afterEach, describe, expect, it } from "vitest";

import { assertOrigin } from "../../../src/learning/api/auth.ts";
import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  cookieToken,
  request,
  startAuthHarness,
  type AuthHarness,
} from "../helpers/auth-server.ts";

/**
 * Origin policy for state-changing requests (AC-SEC-03).
 *
 * Same-origin or an absent Origin passes; a cross-site Origin, `Origin: null`
 * and a scheme mismatch are rejected. `GET` never consults the Origin.
 */

const PORT = 4319;

function expectForbidden(origin: string | undefined): void {
  let caught: unknown = null;
  try {
    assertOrigin(origin, PORT);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LearningError);
  const error = caught as LearningError;
  expect(error.code).toBe("forbidden_origin");
  expect(error.status).toBe(403);
}

describe("assertOrigin unit behavior", () => {
  it("passes an absent or empty Origin", () => {
    expect(() => {
      assertOrigin(undefined, PORT);
    }).not.toThrow();
    expect(() => {
      assertOrigin("", PORT);
    }).not.toThrow();
    expect(() => {
      assertOrigin("   ", PORT);
    }).not.toThrow();
  });

  it("passes same-origin http for both allowlisted host names", () => {
    expect(() => {
      assertOrigin(`http://127.0.0.1:${PORT}`, PORT);
    }).not.toThrow();
    expect(() => {
      assertOrigin(`http://localhost:${PORT}`, PORT);
    }).not.toThrow();
    expect(() => {
      assertOrigin(`HTTP://LOCALHOST:${PORT}`, PORT);
    }).not.toThrow();
  });

  it("rejects Origin: null (opaque origin)", () => {
    expectForbidden("null");
    expectForbidden("NULL");
  });

  it("rejects a different scheme on the same host", () => {
    expectForbidden(`https://127.0.0.1:${PORT}`);
    expectForbidden(`https://localhost:${PORT}`);
  });

  it("rejects a foreign host or a different port", () => {
    expectForbidden("http://evil.example");
    expectForbidden(`http://evil.example:${PORT}`);
    expectForbidden(`http://127.0.0.1:${PORT + 1}`);
    expectForbidden("http://127.0.0.1");
  });

  it("rejects an Origin that smuggles a path or userinfo", () => {
    expectForbidden(`http://127.0.0.1:${PORT}/evil`);
    expectForbidden(`http://user:pass@127.0.0.1:${PORT}`);
    expectForbidden(`http://127.0.0.1:${PORT}?x=1`);
  });

  it("rejects a value that is not a URL", () => {
    expectForbidden("127.0.0.1:4319");
    expectForbidden("not a url");
  });
});

describe("Origin enforcement per method on a real listener", () => {
  let harness: AuthHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  async function session(): Promise<{
    server: AuthHarness;
    cookie: string;
  }> {
    harness = await startAuthHarness();
    const bootstrap = await request(harness.port, {
      path: "/session/bootstrap",
    });
    const token = cookieToken(bootstrap.headers) as string;
    return { server: harness, cookie: `codetrail_session=${token}` };
  }

  it("rejects a cross-site Origin on POST/PUT/DELETE", async () => {
    const { server, cookie } = await session();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await request(server.port, {
        method,
        path: "/api/projects",
        headers: { Cookie: cookie, Origin: "http://evil.example" },
      });
      expect(response.status, method).toBe(403);
      expect(JSON.parse(response.text), method).toMatchObject({
        error: { code: "forbidden_origin" },
      });
    }
  });

  it("passes a same-origin Origin on POST", async () => {
    const { server, cookie } = await session();
    const response = await request(server.port, {
      method: "POST",
      path: "/api/projects",
      headers: {
        Cookie: cookie,
        Origin: `http://localhost:${String(server.port)}`,
      },
    });
    expect(response.status).toBe(200);
  });

  it("passes an absent Origin on POST", async () => {
    const { server, cookie } = await session();
    const response = await request(server.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
  });

  it("does not consult Origin on GET", async () => {
    const { server, cookie } = await session();
    const response = await request(server.port, {
      path: "/api/projects",
      headers: { Cookie: cookie, Origin: "http://evil.example" },
    });
    expect(response.status).toBe(200);
  });

  it("rejects Origin: null on a state-changing request", async () => {
    const { server, cookie } = await session();
    const response = await request(server.port, {
      method: "POST",
      path: "/api/projects",
      headers: { Cookie: cookie, Origin: "null" },
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toMatchObject({
      error: { code: "forbidden_origin" },
    });
  });
});
