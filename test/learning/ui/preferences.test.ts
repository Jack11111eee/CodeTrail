import { describe, expect, it } from "vitest";

import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";
import { pageContext, settingsModel } from "./fixtures.ts";

/** AC-UI-08: preference, background and reading position stay separate. */
describe("preferences", () => {
  it("renders the explanation preference and background as separate inputs", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(html).toContain('name="explainLevel"');
    expect(html).toContain('value="plain_first"');
    expect(html).toContain('value="technical_first"');
    expect(html).toContain('name="background"');
    expect(html).toContain("会一点 Python");
  });

  it("renders reading positions outside the preference form", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(html).toContain('data-generation-id="g_0123456789abcdef"');
    expect(html).toContain('data-lesson-id="l_0123456789abcdef"');
    expect(html).toContain('data-offset="42"');
    expect(html).toContain("阅读位置");
  });

  it("has no mastery, score or proficiency field anywhere", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(html).not.toMatch(/mastery|proficiency/iu);
    expect(html).not.toMatch(/\bscore\b/iu);
    expect(html).not.toContain('name="mastery"');
    expect(html).not.toContain('name="score"');
  });

  it("does not merge background into the reading position input", () => {
    const html = renderSettingsPage(pageContext, settingsModel());
    expect(html).toContain("<form data-preferences-form>");
    expect(html).toContain('<ul class="reading-positions">');
    expect(html).toContain("自动保存");
    expect(html).not.toContain('name="offset"');
  });
});
