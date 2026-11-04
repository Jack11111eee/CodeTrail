import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../../../src/learning/api/router.ts";
import {
  errorCode,
  httpRequest,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * A known path with the wrong method is 405 + a correct `Allow` header
 * (AC-API-08). No path may quietly treat a write as a read.
 */

const METHOD_ORDER = ["GET", "POST", "PUT", "DELETE"] as const;
type Method = (typeof METHOD_ORDER)[number];

function allowedFor(pattern: string): Method[] {
  const methods = ROUTES.filter((route) => route.pattern === pattern).map(
    (route) => route.method,
  );
  return METHOD_ORDER.filter((method) => methods.includes(method));
}

function disallowedMethod(pattern: string): Method {
  const allowed = allowedFor(pattern);
  const candidate = METHOD_ORDER.find((method) => !allowed.includes(method));
  if (candidate === undefined) throw new Error(`all methods allowed: ${pattern}`);
  return candidate;
}

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+/gu, (param) => `x_${param.slice(1)}`);
}

let server: StubServer | null = null;

beforeAll(async () => {
  server = await startStubServer();
});

afterAll(async () => {
  await server?.close();
  server = null;
});

describe("wrong method → 405 method_not_allowed with Allow", () => {
  for (const route of ROUTES) {
    const allowed = allowedFor(route.pattern);
    const method = disallowedMethod(route.pattern);
    it(`${method} ${route.pattern} → 405 Allow: ${allowed.join(", ")}`, async () => {
      const response = await httpRequest(server!.port, {
        method,
        path: concretePath(route.pattern),
        headers: { ...server!.cookie },
      });
      expect(response.status).toBe(405);
      expect(errorCode(response)).toBe("method_not_allowed");
      expect(response.headers.allow).toBe(allowed.join(", "));
    });
  }

  it("never answers a write to a read-only path with 200", async () => {
    for (const path of ["/api/health", "/api/jobs/job_1/events", "/api/usage"]) {
      const response = await httpRequest(server!.port, {
        method: "POST",
        path,
        headers: { ...server!.cookie },
      });
      expect(response.status).toBe(405);
    }
  });
});
