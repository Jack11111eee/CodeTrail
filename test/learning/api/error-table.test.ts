import { describe, expect, it } from "vitest";

import {
  HTTP_STATUS_BY_CODE,
  LearningError,
  REASON_STATUS,
  errorMessageFor,
  toErrorBody,
  type ErrorReason,
  type HttpErrorCode,
} from "../../../src/learning/contracts/index.ts";

/**
 * Contract-level error table (AC-API-07, table half).
 *
 * The mapping is hard-coded from PRD §5 so the test cannot drift with the
 * implementation. `invalid_path` is added by AC-PRJ-02 and must map to 400.
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

describe("HTTP_STATUS_BY_CODE equals the PRD §5 mapping", () => {
  it("matches every code, including invalid_path -> 400", () => {
    expect(HTTP_STATUS_BY_CODE).toEqual(PRD_SECTION_5);
    expect(HTTP_STATUS_BY_CODE.invalid_path).toBe(400);
  });

  it("has an entry for every HttpErrorCode and no extra runtime keys", () => {
    expect(Object.keys(HTTP_STATUS_BY_CODE).sort()).toEqual(
      Object.keys(PRD_SECTION_5).sort(),
    );
  });

  it("does not treat job/source statuses as HTTP codes", () => {
    expect(HTTP_STATUS_BY_CODE).not.toHaveProperty("interrupted");
    expect(HTTP_STATUS_BY_CODE).not.toHaveProperty("cancelled");
    expect(HTTP_STATUS_BY_CODE).not.toHaveProperty("source_missing");
    expect(Object.values(HTTP_STATUS_BY_CODE)).not.toContain("interrupted");
    expect(Object.values(HTTP_STATUS_BY_CODE)).not.toContain("source_missing");
  });
});

describe("REASON_STATUS is the single reason -> code source", () => {
  it("maps every ErrorReason to its documented code", () => {
    expect(REASON_STATUS).toEqual(EXPECTED_REASON_STATUS);
  });

  it("only ever names a valid HttpErrorCode", () => {
    for (const code of Object.values(REASON_STATUS)) {
      expect(PRD_SECTION_5[code]).toBeTypeOf("number");
    }
  });

  it("keeps project_removed (410) and project_removed_read_only (409) distinct", () => {
    expect(REASON_STATUS.project_removed).toBe("source_removed");
    expect(REASON_STATUS.project_removed_read_only).toBe("conflict");
  });
});

describe("LearningError and the error funnel", () => {
  it("uses HTTP_STATUS_BY_CODE for every code", () => {
    for (const [code, status] of Object.entries(PRD_SECTION_5) as [
      HttpErrorCode,
      number,
    ][]) {
      expect(new LearningError(code, "message").status).toBe(status);
    }
  });

  it("produces the fixed error body shape", () => {
    const body = toErrorBody(
      new LearningError("invalid_path", "missing", { reason: "invalid_path" }),
    );
    expect(body).toEqual({
      error: {
        code: "invalid_path",
        message: "missing",
        details: { reason: "invalid_path" },
      },
    });
    expect(toErrorBody(new Error("do not leak /Users/me"))).toEqual({
      error: {
        code: "internal_error",
        message: errorMessageFor("internal_error", "zh"),
      },
    });
  });
});
