// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { pageContext, projectsModel } from "./fixtures.ts";

/**
 * The GitHub import form's `ref` field is optional: an empty string would be
 * rejected by the API's `nonEmptyString.optional()` schema, so the bundle must
 * omit the key entirely.
 */
function renderIntoDocument(html: string): void {
  document.open();
  document.write(html);
  document.close();
}

async function submitGithubForm(refValue: string) {
  const html = renderProjectsPage(pageContext, projectsModel());
  renderIntoDocument(html);

  const fetchMock = vi.fn(async () => ({
    ok: false,
    json: async () => null,
  }));
  vi.stubGlobal("fetch", fetchMock);

  await import("../../../src/learning/ui/client.ts");

  const form = document.querySelector<HTMLFormElement>(
    "[data-testid='project-add-github']",
  );
  const url = form?.querySelector<HTMLInputElement>('input[name="githubUrl"]');
  const ref = form?.querySelector<HTMLInputElement>('input[name="ref"]');
  expect(form).not.toBeNull();
  if (url !== null && url !== undefined) {
    url.value = "https://github.com/owner/repo";
  }
  if (ref !== null && ref !== undefined) ref.value = refValue;
  form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [, init] = fetchMock.mock.calls[0] as [
    string,
    { method: string; body: string },
  ];
  vi.unstubAllGlobals();
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("GitHub project form", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("omits ref when the field is blank", async () => {
    const body = await submitGithubForm("");
    expect(body).toEqual({ githubUrl: "https://github.com/owner/repo" });
    expect(body).not.toHaveProperty("ref");
  });

  it("includes ref when the field is filled", async () => {
    const body = await submitGithubForm("main");
    expect(body).toEqual({
      githubUrl: "https://github.com/owner/repo",
      ref: "main",
    });
  });
});
