import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import { createStaticUi, UI_ROUTES } from "../../../src/learning/api/static.ts";
import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { httpRequest, startStubServer } from "../helpers/stub-server.ts";
import type { StubServer } from "../helpers/stub-server.ts";
import {
  pageContext,
  projectsModel,
  projectSummary,
  staticDeps,
} from "./fixtures.ts";

/** AC-UI-01: the projects page and its status card. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("projects page", () => {
  it("renders every required testid exactly once", () => {
    const html = renderProjectsPage(pageContext, projectsModel());
    for (const testid of [
      "project-list",
      "project-add-local",
      "project-add-github",
      "project-status",
      "project-dependents",
      "project-remove-confirm",
    ]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
  });

  it("shows repository, branch, analysed commit, last success and job state", () => {
    const html = renderProjectsPage(
      pageContext,
      projectsModel({
        projects: [
          projectSummary({
            displayName: "example-repo",
            defaultBranch: "trunk",
            analyzedCommitSha: "a".repeat(40),
            lastSuccessAt: "2026-01-02T03:04:05.000Z",
            latestJobState: "failed",
          }),
        ],
      }),
    );

    expect(html).toContain("example-repo");
    expect(html).toContain("trunk");
    expect(html).toContain("aaaaaaaaaaaa");
    expect(html).toContain("2026-01-02T03:04:05.000Z");
    expect(html).toContain("失败");
    expect(html).toContain('data-project-id="p_0123456789abcdef"');
  });

  it("renders the local and GitHub import forms", () => {
    const html = renderProjectsPage(pageContext, projectsModel());
    expect(html).toContain('data-project-kind="local"');
    expect(html).toContain('name="localPath"');
    expect(html).toContain('data-project-kind="github"');
    expect(html).toContain('name="githubUrl"');
    expect(html).toContain('name="ref"');
    expect(html).toContain("查看移除依赖");
  });

  it("has no inline script, CDN or non-self asset origin", () => {
    const html = renderProjectsPage(pageContext, projectsModel());
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
    expect(html).not.toContain("cdn.");
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).toContain('href="/assets/styles.css"');
    expect(html).toContain('src="/assets/client.js"');
  });

  it("renders an empty state without losing the testids", () => {
    const html = renderProjectsPage(
      pageContext,
      projectsModel({ projects: [], modelConfigured: false }),
    );
    expect(html).toContain("尚无项目");
    expect(html).toContain("未配置");
    expect(countTestId(html, "project-list")).toBe(1);
  });
});

describe("static-UI seam through a real listener", () => {
  it("declares exactly the documented UI route table", () => {
    expect(UI_ROUTES.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      "GET /",
      "GET /learn",
      "GET /learn/reader",
      "GET /inbox",
      "GET /terms",
      "GET /settings",
      "GET /assets/*",
    ]);
  });

  let server: StubServer | null = null;

  beforeEach(async () => {
    const paths = resolveDataPaths(process.env);
    await ensureDataDir(paths);
    server = await startStubServer({
      paths,
      ui: createStaticUi(staticDeps(paths)),
    });
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves the projects page at / without a session cookie", async () => {
    const response = await httpRequest(server!.port, { path: "/" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain('data-testid="project-list"');
  });

  it("serves every page and the stylesheet", async () => {
    for (const [path, testid] of [
      ["/learn/reader", "reader-nav"],
      ["/inbox", "inbox-list"],
      ["/terms", "term-zh"],
      ["/settings", "settings-model-scope"],
    ] as const) {
      const response = await httpRequest(server!.port, {
        path,
        headers: { ...server!.cookie },
      });
      expect(response.status, path).toBe(200);
      expect(response.text, path).toContain(`data-testid="${testid}"`);
    }

    const styles = await httpRequest(server!.port, {
      path: "/assets/styles.css",
      headers: { ...server!.cookie },
    });
    expect(styles.status).toBe(200);
    expect(styles.headers["content-type"]).toContain("text/css");
    expect(styles.text).toContain("@media (max-width: 900px)");
  });
});
