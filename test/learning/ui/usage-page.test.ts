import { describe, expect, it } from "vitest";

import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";
import { pageContext, settingsModel, usageView } from "./fixtures.ts";

/** AC-UI-10: per-task usage grouped by kind, "仅用量" when unpriced. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("usage page", () => {
  it("groups tokens and calls by initial, update, comparison and qa", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(countTestId(html, "settings-usage")).toBe(1);
    for (const kind of ["initial", "update", "comparison", "qa"]) {
      expect(html, kind).toContain(`data-kind="${kind}"`);
    }
    expect(html).toContain("初次分析");
    expect(html).toContain("更新分析");
    expect(html).toContain("对比");
    expect(html).toContain("追问");
    expect(html).toContain("输入 tokens");
    expect(html).toContain("输出 tokens");
    expect(html).toContain("调用次数");
  });

  it("shows only usage when pricing is unconfigured", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(html).toContain("仅用量");
    expect(html).toContain('data-pricing-configured="false"');
    expect(html).not.toContain(" 分</td>");
  });

  it("shows a cost when pricing is configured", () => {
    const html = renderSettingsPage(
      pageContext,
      settingsModel({
        model: { ...settingsModel().model, pricingConfigured: true },
        usage: usageView({
          groups: [
            {
              kind: "initial",
              inputTokens: 10,
              outputTokens: 5,
              calls: 1,
              costCents: 7,
            },
          ],
          totals: {
            inputTokens: 10,
            outputTokens: 5,
            calls: 1,
            costCents: 7,
            pricingConfigured: true,
          },
        }),
      }),
    );
    expect(html).toContain("7 分");
    expect(html).toContain('data-pricing-configured="true"');
    expect(html).not.toContain("仅用量");
  });

  it("renders zero rows for kinds with no usage", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(html).toContain('<tr data-kind="update">');
    expect(html).toContain("<td>0</td>");
  });
});
