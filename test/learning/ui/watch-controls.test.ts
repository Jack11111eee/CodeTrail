import { describe, expect, it } from "vitest";

import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";
import { POLLING_NOTE } from "../../../src/learning/ui/pages/layout.ts";
import { pageContext, settingsModel } from "./fixtures.ts";

/** AC-UI-11 and AC-UPD-26: watch controls and the polling limitation. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("watch controls", () => {
  it("disables the toggle for a local project and states why", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(countTestId(html, "settings-watch-toggle")).toBe(1);
    expect(html).toContain("本地项目没有远端可轮询");
    expect(html).toMatch(
      /<input[^>]*data-testid="settings-watch-toggle"[^>]*disabled/u,
    );
    expect(html).toContain('data-available="false"');
  });

  it("offers a manual refresh beside the toggle", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(countTestId(html, "settings-watch-refresh")).toBe(1);
    expect(html).toContain('data-refresh-now="true"');
    expect(html).toContain("手动刷新");
  });

  it("enables the toggle for a GitHub project", () => {
    const html = renderSettingsPage(
      pageContext,
      settingsModel({
        watch: {
          enabled: true,
          available: true,
          reason: null,
          lastPollAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    expect(html).toContain('data-available="true"');
    expect(html).toContain("checked");
    expect(html).not.toMatch(
      /<input[^>]*data-testid="settings-watch-toggle"[^>]*disabled/u,
    );
  });

  it("states the force-push capture limit in the polling note", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(countTestId(html, "polling-note")).toBe(1);
    expect(html).toContain("force-push");
    expect(html).toContain("无法保证");
    expect(POLLING_NOTE).toContain("force-push");
    expect(html).toContain(POLLING_NOTE);
  });
});
