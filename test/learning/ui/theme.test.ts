// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { pageContext, projectsModel } from "./fixtures.ts";
const script = fs.readFileSync(
  path.resolve("src/learning/ui/theme.js"),
  "utf8",
);
function run() {
  window.eval(script);
  document.dispatchEvent(new Event("DOMContentLoaded"));
}
beforeEach(() => {
  document.open();
  document.write(renderProjectsPage(pageContext, projectsModel()));
  document.close();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
describe("appearance selection", () => {
  it("loads the local theme initializer before the stylesheet under the existing CSP", () => {
    const html = renderProjectsPage(pageContext, projectsModel());
    expect(html.indexOf('src="/assets/theme.js"')).toBeLessThan(
      html.indexOf('href="/assets/styles.css"'),
    );
    expect(html).toContain('aria-label="外观模式"');
  });
  it("defaults to the system and remembers a manual choice across pages", () => {
    run();
    const select = document.querySelector<HTMLSelectElement>(
      "[data-theme-select]",
    )!;
    expect(document.documentElement.dataset.theme).toBe("system");
    select.value = "dark";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("codetrail:theme")).toBe("dark");
    document.documentElement.dataset.theme = "system";
    run();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(select.value).toBe("dark");
    select.value = "light";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("light");
    select.value = "system";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("system");
  });
  it("syncs other tabs and ignores unrecognized saved themes", () => {
    localStorage.setItem("codetrail:theme", "invalid");
    run();
    expect(document.documentElement.dataset.theme).toBe("system");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "codetrail:theme", newValue: "dark" }),
    );
    expect(
      document.querySelector<HTMLSelectElement>("[data-theme-select]")?.value,
    ).toBe("dark");
  });
  it("still switches when local storage is unavailable", () => {
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    try {
      run();
      const select = document.querySelector<HTMLSelectElement>(
        "[data-theme-select]",
      )!;
      select.value = "dark";
      select.dispatchEvent(new Event("change"));
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});
