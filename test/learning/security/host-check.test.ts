import { afterEach, describe, expect, it } from "vitest";

import { assertHost } from "../../../src/learning/api/auth.ts";
import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  cookieToken,
  rawRequest,
  rawStatus,
  request,
  startAuthHarness,
  type AuthHarness,
} from "../helpers/auth-server.ts";

/**
 * Host allowlist (AC-SEC-02).
 *
 * Only `127.0.0.1:<port>` and `localhost:<port>` pass; a missing Host is
 * rejected. The missing-Host case needs a raw HTTP/1.0 exchange because every
 * Node HTTP client adds a Host header.
 */

const PORT = 4319;

function expectForbidden(run: () => void): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LearningError);
  const error = caught as LearningError;
  expect(error.code).toBe("forbidden_origin");
  expect(error.status).toBe(403);
}

describe("assertHost allowlist", () => {
  it("passes 127.0.0.1 and localhost on the listening port", () => {
    expect(() => {
      assertHost(`127.0.0.1:${PORT}`, PORT);
    }).not.toThrow();
    expect(() => {
      assertHost(`localhost:${PORT}`, PORT);
    }).not.toThrow();
  });

  it("treats host names case-insensitively and ignores one trailing dot", () => {
    expect(() => {
      assertHost(`LOCALHOST:${PORT}`, PORT);
    }).not.toThrow();
    expect(() => {
      assertHost(`localhost.:${PORT}`, PORT);
    }).not.toThrow();
    expect(() => {
      assertHost(` 127.0.0.1:${PORT} `, PORT);
    }).not.toThrow();
  });

  it("rejects a missing or empty Host", () => {
    expectForbidden(() => {
      assertHost(undefined, PORT);
    });
    expectForbidden(() => {
      assertHost("", PORT);
    });
    expectForbidden(() => {
      assertHost("   ", PORT);
    });
  });

  it("rejects a port mismatch", () => {
    expectForbidden(() => {
      assertHost("127.0.0.1:4318", PORT);
    });
    expectForbidden(() => {
      assertHost("localhost:1", PORT);
    });
  });

  it("rejects a Host without a port", () => {
    expectForbidden(() => {
      assertHost("127.0.0.1", PORT);
    });
    expectForbidden(() => {
      assertHost("localhost", PORT);
    });
  });

  it("rejects a foreign host, including suffix tricks", () => {
    expectForbidden(() => {
      assertHost(`evil.example:${PORT}`, PORT);
    });
    expectForbidden(() => {
      assertHost(`127.0.0.1:${PORT}.evil.example`, PORT);
    });
    expectForbidden(() => {
      assertHost(`evil.example@127.0.0.1:${PORT}`, PORT);
    });
    expectForbidden(() => {
      assertHost(`127.0.0.1:${PORT}#@evil.example`, PORT);
    });
  });

  it("rejects IPv6 hosts: the server only binds IPv4 loopback", () => {
    expectForbidden(() => {
      assertHost(`[::1]:${PORT}`, PORT);
    });
    expectForbidden(() => {
      assertHost(`[::ffff:127.0.0.1]:${PORT}`, PORT);
    });
  });
});

describe("Host enforcement on a real listener", () => {
  let harness: AuthHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close();
      harness = null;
    }
  });

  it("rejects a raw HTTP/1.0 request with no Host header", async () => {
    harness = await startAuthHarness();
    const text = await rawRequest(
      harness.port,
      "GET /api/health HTTP/1.0\r\nConnection: close\r\n\r\n",
    );
    expect(rawStatus(text)).toBe(403);
    expect(text).toContain('"code":"forbidden_origin"');
  });

  it("accepts a raw HTTP/1.0 request with an allowed Host", async () => {
    harness = await startAuthHarness();
    const text = await rawRequest(
      harness.port,
      `GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:${String(harness.port)}` +
        "\r\nConnection: close\r\n\r\n",
    );
    expect(rawStatus(text)).toBe(200);
    expect(text).toContain('"status":"ok"');
  });

  it("rejects a foreign Host with 403 forbidden_origin", async () => {
    harness = await startAuthHarness();
    const response = await request(harness.port, {
      path: "/api/health",
      headers: { Host: `evil.example:${String(harness.port)}` },
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toMatchObject({
      error: { code: "forbidden_origin" },
    });
  });

  it("accepts localhost and rejects a port mismatch", async () => {
    harness = await startAuthHarness();

    const allowed = await request(harness.port, {
      path: "/api/health",
      headers: { Host: `localhost:${String(harness.port)}` },
    });
    expect(allowed.status).toBe(200);

    const denied = await request(harness.port, {
      path: "/api/health",
      headers: { Host: `localhost:${String(harness.port + 1)}` },
    });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.text)).toMatchObject({
      error: { code: "forbidden_origin" },
    });
  });

  it("rejects a bad Host before considering a valid session", async () => {
    harness = await startAuthHarness();
    const bootstrap = await request(harness.port, {
      path: "/session/bootstrap",
    });
    const token = cookieToken(bootstrap.headers) as string;

    const response = await request(harness.port, {
      path: "/api/projects",
      headers: {
        Cookie: `codetrail_session=${token}`,
        Host: `evil.example:${String(harness.port)}`,
      },
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toMatchObject({
      error: { code: "forbidden_origin" },
    });
  });
});
