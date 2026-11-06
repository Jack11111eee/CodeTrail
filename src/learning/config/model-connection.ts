import { performance } from "node:perf_hooks";
import { LearningError } from "../contracts/errors.js";
import type {
  ModelSettings,
  TestModelConnectionView,
} from "../contracts/index.js";
import { createModelHandle } from "./model.js";

const TIMEOUT_MS = 10_000;

function failure(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
): LearningError {
  let reason = "connection_failed";
  let message =
    "连接失败，请检查 Base URL、网络，以及服务是否兼容 Anthropic Messages API。";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  if (signal.aborted) {
    reason = "cancelled";
    message = "连接测试已取消。";
  } else if (timeout.aborted) {
    reason = "timeout";
    message = "连接测试超时（10 秒），请检查地址、网络或稍后重试。";
  } else if (status === 401 || status === 403) {
    reason = "authentication_failed";
    message = `认证或权限校验失败（HTTP ${status}），请检查 API Key 和模型访问权限。`;
  } else if (status === 404) {
    reason = "endpoint_or_model_not_found";
    message = "接口或模型不存在（HTTP 404），请检查 Base URL 和模型 ID。";
  } else if (status === 429) {
    reason = "rate_limited";
    message = "服务限流或额度不足（HTTP 429），请检查账户额度或稍后重试。";
  } else if (status === 400 || status === 422) {
    reason = "unsupported_request";
    message = `服务拒绝了测试请求（HTTP ${status}），请检查模型 ID 和 Messages API 兼容性。`;
  } else if (status !== undefined && status >= 500) {
    reason = "service_unavailable";
    message = `模型服务暂时不可用（HTTP ${status}），请稍后重试。`;
  }
  // Never return upstream error bodies: gateways may echo credentials or headers.
  return new LearningError("external_source_unavailable", message, {
    reason,
    ...(status === undefined ? {} : { providerStatus: status }),
  });
}

/** A single unsaved probe: no repository content, retries, or settings writes. */
export async function testModelConnection(
  settings: ModelSettings,
  apiKey: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<TestModelConnectionView> {
  const handle = createModelHandle(
    { ...settings, maxOutputTokens: 16, temperature: 0 },
    {
      ...env,
      CODETRAIL_MODEL_PROVIDER: settings.provider,
      CODETRAIL_MODEL_ID: settings.model,
    },
    apiKey,
    { maxRetries: 0, timeout: TIMEOUT_MS },
  );
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const started = performance.now();
  try {
    const answer = await handle
      .chat()
      .invoke("Reply only with OK.", {
        signal: AbortSignal.any([signal, timeout]),
      });
    if (
      !answer.content ||
      (Array.isArray(answer.content) && answer.content.length === 0)
    ) {
      throw new LearningError(
        "external_source_unavailable",
        "服务返回了空的模型响应，请检查模型和接口兼容性。",
        { reason: "invalid_response" },
      );
    }
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      message: "连接成功，模型已返回有效响应。测试不会保存配置。",
    };
  } catch (error) {
    if (error instanceof LearningError) throw error;
    throw failure(error, signal, timeout);
  }
}
