import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ErrorReason,
  HttpErrorCode,
} from "../../../src/learning/contracts/index.ts";
import {
  HTTP_STATUS_BY_CODE,
  LearningError,
  REASON_STATUS,
} from "../../../src/learning/contracts/index.ts";
import {
  httpRequest,
  jsonBody,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * The single error funnel (AC-API-07).
 *
 * The two tables are copied from PRD §5 and architecture §3.2 rather than
 * imported, so a code added to the implementation but missing from the
 * contract — or a status changed in one place only — fails here.
 */

const PRD_SECTION_5: Record<HttpErrorCode, number> = {
  invalid_input: 400,
  invalid_path: 400,
  model_not_configured: 400,
  watch_requires_github: 400,
  github_auth_failed: 401,
  unauthorized: 401,
  forbidden_origin: 403,
  out_of_scope_path: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  job_not_retryable: 409,
  busy_stream: 409,
  version_mismatch: 409,
  unpublished_generation: 409,
  budget_exhausted: 409,
  object_unavailable: 409,
  protected_write_blocked: 409,
  source_drift: 409,
  source_removed: 410,
  payload_too_large: 413,
  rate_limited: 429,
  external_source_unavailable: 502,
  internal_error: 500,
};

const EXPECTED_REASON_STATUS: Record<ErrorReason, HttpErrorCode> = {
  not_git_repo: "invalid_input",
  invalid_path: "invalid_path",
  local_path_and_url: "invalid_input",
  unsupported_host: "invalid_input",
  unknown_ref: "invalid_input",
  confirm_required: "invalid_input",
  cursor_invalid: "invalid_input",
  blank_teaching: "conflict",
  project_removed: "source_removed",
  generation_immutable: "conflict",
  upstream_state: "invalid_input",
  symlink_escape: "out_of_scope_path",
  seal_mismatch: "internal_error",
  fixture_missing: "internal_error",
  no_model: "model_not_configured",
  project_removed_read_only: "conflict",
  linked_event_missing: "internal_error",
};

interface ErrorShape {
  error: {
    code?: unknown;
    message?: unknown;
    details?: Record<string, unknown>;
  };
}

function shape(response: { text: string }): ErrorShape {
  const parsed = jsonBody({
    status: 0,
    headers: {},
    text: response.text,
  }) as ErrorShape;
  return parsed;
}

let server: StubServer | null = null;
let currentError: unknown = null;

beforeAll(async () => {
  server = await startStubServer({
    handlers: {
      "projects.create": () => () => {
        throw currentError;
      },
    },
  });
});

afterAll(async () => {
  await server?.close();
  server = null;
});

async function throwCode(error: unknown): Promise<{
  status: number;
  text: string;
}> {
  currentError = error;
  const response = await httpRequest(server!.port, {
    method: "POST",
    path: "/api/projects",
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ localPath: "/tmp/example" }),
  });
  return { status: response.status, text: response.text };
}

describe("every HttpErrorCode has the PRD §5 status and a fixed body shape", () => {
  it("covers the table exactly", () => {
    expect(Object.keys(HTTP_STATUS_BY_CODE).sort()).toEqual(
      Object.keys(PRD_SECTION_5).sort(),
    );
  });

  for (const [code, status] of Object.entries(PRD_SECTION_5) as [
    HttpErrorCode,
    number,
  ][]) {
    it(`${code} → ${String(status)}`, async () => {
      const response = await throwCode(
        new LearningError(code, `message:${code}`),
      );
      expect(response.status).toBe(status);
      const body = shape(response);
      expect(body).toEqual({
        error: { code, message: `message:${code}` },
      });
      expect(body.error.details).toBeUndefined();
    });
  }
});

describe("details are preserved only when supplied", () => {
  it("carries a supplied details object verbatim", async () => {
    const response = await throwCode(
      new LearningError("invalid_path", "missing", {
        reason: "invalid_path",
        path: "src/a.ts",
      }),
    );
    expect(response.status).toBe(400);
    expect(shape(response)).toEqual({
      error: {
        code: "invalid_path",
        message: "missing",
        details: { reason: "invalid_path", path: "src/a.ts" },
      },
    });
  });
});

describe("REASON_STATUS is the only reason → code source", () => {
  it("matches the documented pairs", () => {
    expect(REASON_STATUS).toEqual(EXPECTED_REASON_STATUS);
  });

  for (const [reason, code] of Object.entries(EXPECTED_REASON_STATUS) as [
    ErrorReason,
    HttpErrorCode,
  ][]) {
    it(`${reason} accompanies ${code}`, async () => {
      const response = await throwCode(
        new LearningError(code, `reason:${reason}`, { reason }),
      );
      expect(response.status).toBe(PRD_SECTION_5[code]);
      expect(shape(response).error).toEqual({
        code,
        message: `reason:${reason}`,
        details: { reason },
      });
    });
  }
});

describe("unknown failures fail closed", () => {
  it("maps a non-LearningError to 500 internal_error without leaking it", async () => {
    const response = await throwCode(
      new Error("secret /Users/someone/.codetrail/db"),
    );
    expect(response.status).toBe(500);
    const body = shape(response);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("内部错误");
    expect(response.text).not.toContain("/Users/");
    expect(response.text).not.toContain("secret");
    expect(response.text).not.toContain("at ");
  });

  it("returns 401 unauthorized as a properly shaped body", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/projects",
    });
    expect(response.status).toBe(401);
    expect(shape(response)).toEqual({
      error: { code: "unauthorized", message: "需要会话凭证" },
    });
  });
});
