/**
 * The closed error vocabulary and the single code → HTTP status table.
 *
 * Every error body in the HTTP API is `{error:{code,message,details?}}`; the
 * status is always `HTTP_STATUS_BY_CODE[code]`. Handlers never choose a status
 * themselves, and a known `details.reason` always maps through `REASON_STATUS`.
 */

/** Every error code that may appear in an HTTP response body. */
export type HttpErrorCode =
  | "invalid_input"
  | "invalid_path"
  | "model_not_configured"
  | "watch_requires_github"
  | "github_auth_failed"
  | "unauthorized"
  | "forbidden_origin"
  | "out_of_scope_path"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "job_not_retryable"
  | "busy_stream"
  | "version_mismatch"
  | "unpublished_generation"
  | "budget_exhausted"
  | "object_unavailable"
  | "protected_write_blocked"
  | "source_drift"
  | "source_removed"
  | "payload_too_large"
  | "rate_limited"
  | "external_source_unavailable"
  | "internal_error";

export const HTTP_STATUS_BY_CODE: Readonly<Record<HttpErrorCode, number>> = {
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

export interface ErrorBody {
  error: {
    code: HttpErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class LearningError extends Error {
  readonly code: HttpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: HttpErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LearningError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }
}

const ZH_MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  invalid_input: "输入无效",
  invalid_path: "路径不存在或不可读",
  model_not_configured: "模型尚未配置",
  watch_requires_github: "只有 GitHub 项目可以开启跟进",
  github_auth_failed: "GitHub 认证失败",
  unauthorized: "需要会话凭证",
  forbidden_origin: "来源不被允许",
  out_of_scope_path: "路径超出允许范围",
  not_found: "未找到",
  method_not_allowed: "请求方法不被允许",
  conflict: "请求与当前状态冲突",
  job_not_retryable: "该任务不可重试",
  busy_stream: "该流已有正在运行的任务",
  version_mismatch: "版本不匹配",
  unpublished_generation: "该生成版本尚未发布",
  budget_exhausted: "模型配额已用尽",
  object_unavailable: "Git 对象不可用",
  protected_write_blocked: "上游尝试写入受保护路径",
  source_drift: "来源内容已变化",
  source_removed: "来源已被移除",
  payload_too_large: "请求体过大",
  rate_limited: "请求过于频繁",
  external_source_unavailable: "外部资料暂不可用",
  internal_error: "内部错误",
};

export function errorMessageFor(code: HttpErrorCode, _locale: "zh"): string {
  void _locale;
  return ZH_MESSAGES[code];
}

export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof LearningError) {
    const body: ErrorBody = {
      error: { code: e.code, message: e.message },
    };
    if (e.details !== undefined) {
      body.error.details = e.details;
    }
    return body;
  }
  return {
    error: { code: "internal_error", message: ZH_MESSAGES.internal_error },
  };
}

/** NOT HTTP codes. */
export type JobErrorCode =
  | "interrupted"
  | "cancelled"
  | "superseded"
  | "object_unavailable"
  | "source_drift"
  | "protected_write_blocked"
  | "budget_exhausted"
  | "rate_limited"
  | "github_auth_failed"
  | "model_not_configured"
  | "external_source_unavailable"
  | "internal_error";

export type SourceStatus = "available" | "source_missing" | "source_removed";

/**
 * The closed `details.reason` vocabulary. The third column in the architecture
 * table is the code each reason must accompany; `REASON_STATUS` is the single
 * source for that pairing.
 */
export type ErrorReason =
  | "not_git_repo"
  | "invalid_path"
  | "local_path_and_url"
  | "unsupported_host"
  | "unknown_ref"
  | "confirm_required"
  | "cursor_invalid"
  | "blank_teaching"
  | "project_removed"
  | "generation_immutable"
  | "upstream_state"
  | "symlink_escape"
  | "seal_mismatch"
  | "fixture_missing"
  | "no_model"
  | "project_removed_read_only"
  | "linked_event_missing";

export const REASON_STATUS: Readonly<Record<ErrorReason, HttpErrorCode>> = {
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
