import { LearningError } from "../contracts/errors.js";

/** The service root, without an API operation such as /v1/messages. */
export function normalizeModelBaseUrl(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      trimmed.length > 2048
    ) {
      throw new Error("invalid base URL");
    }
    return url.href.replace(/\/+$/u, "");
  } catch {
    throw new LearningError(
      "invalid_input",
      "Base URL 必须是有效的 HTTP(S) 服务地址，不能包含账号、密码、查询参数或片段。",
      { field: "baseUrl" },
    );
  }
}
