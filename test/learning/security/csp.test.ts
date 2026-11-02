import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";

import { CONTENT_SECURITY_POLICY } from "../../../src/learning/api/respond.ts";
import type {
  RouteResponse,
  StaticUiSeam,
} from "../../../src/learning/contracts/index.ts";
import {
  httpRequest,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * Every HTML response carries the strict §16 CSP (AC-SEC-05), including a page
 * produced by the static-UI seam and an HTML error page.
 */

function page(title: string): string {
  return (
    "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">" +
    `<title>${title}</title><link rel="stylesheet" href="/assets/styles.css">` +
    `<script src="/assets/client.js" defer></script></head>` +
    `<body><h1 data-testid="project-list">${title}</h1></body></html>`
  );
}

const ui: StaticUiSeam = {
  routes: [
    { method: "GET", pattern: "/" },
    { method: "GET", pattern: "/learn" },
    { method: "GET", pattern: "/boom" },
    { method: "GET", pattern: "/assets/*" },
  ],
  handle(req): Promise<RouteResponse | null> {
    const path = req.params.path;
    if (path === "/boom") {
      throw new Error("secret /Users/someone/.codetrail/db.sqlite");
    }
    if (path?.startsWith("/assets/")) {
      return Promise.resolve({
        kind: "empty",
        status: 200,
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    }
    return Promise.resolve({
      kind: "json",
      status: 200,
      body: page(path === "/" ? "projects" : "learn"),
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

let server: StubServer | null = null;

beforeAll(async () => {
  server = await startStubServer({ ui });
});

afterAll(async () => {
  await server?.close();
  server = null;
});

function csp(headers: IncomingHttpHeaders): string {
  const value = headers["content-security-policy"];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

describe("Content-Security-Policy on HTML responses", () => {
  it("is the exact §16 policy", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; connect-src 'self'; " +
        "img-src 'self' data:; style-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });

  it("is present on a stub seam page", async () => {
    const response = await httpRequest(server!.port, {
      path: "/learn",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(csp(response.headers)).toBe(CONTENT_SECURITY_POLICY);
    expect(response.text).toContain("data-testid=\"project-list\"");
  });

  it("forbids inline/eval script and allows only self", () => {
    const value = CONTENT_SECURITY_POLICY;
    expect(value).toContain("default-src 'none'");
    expect(value).toContain("script-src 'self'");
    expect(value).toContain("connect-src 'self'");
    expect(value).not.toContain("unsafe-inline");
    expect(value).not.toContain("unsafe-eval");
    expect(value).not.toMatch(/script-src[^;]*https?:/u);
  });

  it("is present on the public entry page and mints the cookie", async () => {
    const response = await httpRequest(server!.port, { path: "/" });
    expect(response.status).toBe(200);
    expect(csp(response.headers)).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("is present on an HTML error page without leaking the error", async () => {
    const response = await httpRequest(server!.port, {
      path: "/boom",
      headers: { ...server!.cookie, Accept: "text/html" },
    });
    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(csp(response.headers)).toBe(CONTENT_SECURITY_POLICY);
    expect(response.text).not.toContain("/Users/");
    expect(response.text).not.toContain("secret");
    expect(response.text).not.toContain("at ");
  });

  it("does not attach the page CSP to a JSON error", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/nothing-here",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(csp(response.headers)).toBe("");
  });
});
