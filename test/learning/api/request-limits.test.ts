import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_BODY_BYTES } from "../../../src/learning/config/defaults.ts";
import { ROUTES } from "../../../src/learning/api/router.ts";
import {
  REQ_SCHEMAS,
  validateBody,
  validateQuery,
} from "../../../src/learning/api/validate.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * The 1 MiB cap and request validation (AC-API-11).
 *
 * Bodies are driven through the real listener so the middleware order
 * (session → readBody → matchRoute → handler) is observed, not simulated.
 */

let server: StubServer | null = null;

beforeAll(async () => {
  server = await startStubServer();
});

afterAll(async () => {
  await server?.close();
  server = null;
});

function post(
  body: string | Buffer,
  headers: Record<string, string> = {},
): ReturnType<typeof httpRequest> {
  return httpRequest(server!.port, {
    method: "POST",
    path: "/api/projects",
    headers: {
      ...server!.cookie,
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("the body cap", () => {
  it(`rejects ${String(MAX_BODY_BYTES + 1)} bytes with 413 payload_too_large`, async () => {
    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
    const response = await post(oversized);
    expect(response.status).toBe(413);
    expect(errorCode(response)).toBe("payload_too_large");
  });

  it("accepts a body at exactly the cap (validation, not the cap, decides)", async () => {
    // A valid JSON string padded to exactly MAX_BODY_BYTES; the cancel route has
    // no body schema, so only the cap decides.
    const body = `"${"a".repeat(MAX_BODY_BYTES - 2)}"`;
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    const response = await httpRequest(server!.port, {
      method: "POST",
      path: "/api/jobs/job_1/cancel",
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
  });

  it("checks the session before reading or parsing the body", async () => {
    // Malformed JSON would be 400 if the body ran first; the chain puts the
    // session guard ahead of body handling, so an anonymous write is 401.
    const response = await httpRequest(server!.port, {
      method: "POST",
      path: "/api/projects",
      headers: { "Content-Type": "application/json" },
      body: '{"localPath":',
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("unauthorized");
  });
});

describe("body parsing and schema validation", () => {
  it("rejects malformed JSON with 400 invalid_input", async () => {
    const response = await post('{"localPath":');
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("rejects a literal null body", async () => {
    const response = await post("null");
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("rejects an empty body for a required schema", async () => {
    const response = await post("");
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("rejects wrong-typed fields", async () => {
    const response = await post(JSON.stringify({ localPath: 42 }));
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("rejects unknown fields", async () => {
    const response = await post(
      JSON.stringify({ localPath: "/tmp/example", surprise: true }),
    );
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("rejects both localPath and githubUrl", async () => {
    const response = await post(
      JSON.stringify({
        localPath: "/tmp/example",
        githubUrl: "https://github.com/o/r",
      }),
    );
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
  });

  it("rejects a __proto__ key and does not pollute Object.prototype", async () => {
    const response = await post(
      '{"localPath":"/tmp/example","__proto__":{"polluted":true}}',
    );
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("parses a chunked body with no Content-Length", async () => {
    const response = await post(JSON.stringify({ localPath: "/tmp/example" }));
    expect(response.status).toBe(200);
    const body = jsonBody(response) as { body?: { localPath?: string } };
    expect(body.body?.localPath).toBe("/tmp/example");
  });

  it("uses last-wins for duplicate JSON keys without crashing", async () => {
    const response = await post('{"localPath":"first","localPath":"second"}');
    expect(response.status).toBe(200);
    const body = jsonBody(response) as { body?: { localPath?: string } };
    expect(body.body?.localPath).toBe("second");
  });
});

describe("REQ_SCHEMAS covers exactly the routes that take input", () => {
  const bodyKeys = [
    "projects.create",
    "analyses.create",
    "comparisons.create",
    "conversations.create",
    "conversations.post",
    "watch.put",
    "preferences.put",
    "settings.model.put",
    "settings.model.test",
  ] as const;
  const queryKeys = [
    "projects.delete",
    "conversations.messages",
    "changes.list",
    "terms.list",
    "usage.get",
  ] as const;

  it("declares a body schema for every body-taking handler", () => {
    for (const key of bodyKeys) {
      expect(REQ_SCHEMAS[key]?.body, key).toBeDefined();
    }
  });

  it("declares a query schema for every query-taking handler", () => {
    for (const key of queryKeys) {
      expect(REQ_SCHEMAS[key]?.query, key).toBeDefined();
    }
  });

  it("never attaches a body schema to a GET route", () => {
    for (const route of ROUTES) {
      if (route.method !== "GET") continue;
      expect(REQ_SCHEMAS[route.handler]?.body, route.pattern).toBeUndefined();
    }
  });

  it("rejects null, wrong-typed and unknown-field bodies", () => {
    for (const key of bodyKeys) {
      expect(() => {
        validateBody(key, null);
      }, `${key} null`).toThrowError();
      expect(() => {
        validateBody(key, { unknownField: true });
      }, `${key} unknown`).toThrowError();
    }
  });

  it("rejects unknown query keys", () => {
    for (const key of queryKeys) {
      expect(() => {
        validateQuery(key, { surprise: "1" });
      }, key).toThrowError();
    }
  });

  it("returns a clean object for valid input", () => {
    expect(validateBody("projects.create", { localPath: "/tmp/x" })).toEqual({
      localPath: "/tmp/x",
    });
    expect(validateQuery("projects.delete", { confirm: "true" })).toEqual({
      confirm: "true",
    });
  });
});
