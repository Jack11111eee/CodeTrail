/** Safe host-authored reasons; never expose provider bodies or tool arguments. */
export interface PageFailure {
  code: string;
  message: string;
}

function causes(
  error: unknown,
): {
  name?: string;
  code?: string;
  lc_error_code?: string;
  status?: number;
  message?: string;
}[] {
  const result = [];
  const seen = new Set<unknown>();
  let value = error;
  while (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    result.push(value);
    value = (value as { cause?: unknown }).cause;
  }
  return result;
}

export function isMalformedModelResponse(error: unknown): boolean {
  return causes(error).some(
    (value) =>
      value.name === "SyntaxError" ||
      value.lc_error_code === "OUTPUT_PARSING_FAILURE" ||
      /(?:failed to parse tool call arguments|unexpected end of json|unterminated string in json)/iu.test(
        value.message ?? "",
      ),
  );
}

export function pageFailure(error: unknown): PageFailure {
  const chain = causes(error);
  if (chain.some((value) => value.status === 401 || value.status === 403))
    return { code: "provider_auth", message: "模型服务拒绝认证或权限不足" };
  if (
    chain.some(
      (value) =>
        value.status === 429 ||
        /rate.?limit|too many requests/iu.test(value.message ?? ""),
    )
  )
    return { code: "rate_limited", message: "模型服务限流" };
  if (isMalformedModelResponse(error))
    return {
      code: "response_format",
      message: "模型响应或工具参数不是完整的 JSON",
    };
  if (
    chain.some((value) =>
      /timeout|timed out/iu.test(`${value.name ?? ""} ${value.message ?? ""}`),
    )
  )
    return { code: "provider_timeout", message: "模型请求超时" };
  if (
    chain.some((value) =>
      /connection|network|fetch failed/iu.test(value.message ?? ""),
    )
  )
    return { code: "provider_connection", message: "模型服务连接失败" };
  if (chain.some((value) => /model-call limit/iu.test(value.message ?? "")))
    return { code: "page_budget", message: "达到单页模型请求次数上限" };
  if (
    chain.some((value) =>
      /recursion.?limit|recursion.?error/iu.test(
        `${value.name ?? ""} ${value.message ?? ""}`,
      ),
    )
  )
    return { code: "agent_limit", message: "达到页面工作器执行步数上限" };
  if (chain.some((value) => value.code === "invalid_input"))
    return {
      code: "submission_rejected",
      message: "页面内容或代码证据未通过提交校验",
    };
  if (
    chain.some(
      (value) => typeof value.status === "number" && value.status >= 400,
    )
  )
    return { code: "provider_request", message: "模型服务返回请求错误" };
  return { code: "worker_incomplete", message: "页面工作器未能完成提交" };
}
