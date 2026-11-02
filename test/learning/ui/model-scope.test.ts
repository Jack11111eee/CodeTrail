import { describe, expect, it } from "vitest";

import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";
import { pageContext, settingsModel } from "./fixtures.ts";

/** AC-UI-09: provider, model and the data-sent list. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("model scope", () => {
  it("shows provider, model and the data-sent list", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(countTestId(html, "settings-model-scope")).toBe(1);
    expect(html).toContain("anthropic");
    expect(html).toContain("claude-test");
    expect(html).toContain("发送给模型的内容范围");
    for (const entry of [
      "选中代码片段",
      "页面文本",
      "你的问题",
      "偏好摘要",
      "外部资料片段",
    ]) {
      expect(html, entry).toContain(entry);
    }
  });

  it("reports an unconfigured model without hiding the manifest", () => {
    const html = renderSettingsPage(
      pageContext,
      settingsModel({
        model: {
          provider: "",
          model: "",
          pricingConfigured: false,
          quota: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
          dataSent: ["页面文本"],
        },
      }),
    );
    expect(html).toContain("未配置");
    expect(html).toContain("页面文本");
    expect(html).toContain('data-pricing-configured="false"');
  });

  it("reports pricing when it is configured", () => {
    const html = renderSettingsPage(
      pageContext,
      settingsModel({
        model: {
          ...settingsModel().model,
          pricingConfigured: true,
        },
      }),
    );
    expect(html).toContain('data-pricing-configured="true"');
    expect(html).toContain("已配置");
  });
});
