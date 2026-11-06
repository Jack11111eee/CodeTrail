import { afterEach, describe, expect, it } from "vitest";

import type {
  CoverageReport,
  ProjectId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import {
  cleanupTempDirs,
  createQaDb,
  publishGeneration,
  AT,
  PROJECT_ID,
  type QaDb,
} from "../qa/qa-helpers.ts";
import { emptyCursor } from "../../../src/learning/contracts/index.ts";
import { makeChange, makeProject, makeRepo } from "../store/helpers.ts";
import { countTestId, uiDepsFrom } from "./merge-ui-server.ts";

/**
 * Integration: a generation's `coverage.json` (written by the jobs/publish
 * pipeline) is normalised by the ui branch's static seam and rendered by the
 * reader.
 *
 * The ui branch specifically hardened this path so an inconsistent payload
 * (`complete:true` beside non-empty `gaps`) can never render as "complete"
 * (AC-PRJ-16, AC-UI-05). The same seam decides whether the watch panel is
 * usable for a local vs GitHub project from the real project rows.
 */

const GENERATION_ID = "g_level8_coverage";
const GITHUB_PROJECT = "p_level8_github" as ProjectId;
const GITHUB_REPO = "r_level8_github" as RepoId;

const dbs: QaDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  cleanupTempDirs();
});

function open(): QaDb {
  const db = createQaDb();
  dbs.push(db);
  return db;
}

function depsOf(db: QaDb) {
  return uiDepsFrom({
    paths: resolveDataPaths(process.env),
    clock: db.clock,
    db: db.db,
    repos: db.repos,
  });
}

async function page(db: QaDb, url: URL): Promise<string> {
  const response = await createStaticUi(depsOf(db)).handle({
    params: {
      path: url.pathname,
      pattern: url.pathname === "/settings" ? "/settings" : "/learn/reader",
    },
    query: Object.fromEntries(url.searchParams),
    body: undefined,
    headers: {},
    signal: new AbortController().signal,
  });
  expect(response?.kind).toBe("json");
  if (response === null || response.kind !== "json") {
    throw new Error(`${url.pathname} was not rendered`);
  }
  return String(response.body);
}

const COVERAGE_BASE = {
  generationId: GENERATION_ID,
  commitSha: "a".repeat(40),
  analyzed: [{ path: "src/index.ts", bytes: 40, language: "typescript" }],
  counts: { totalFiles: 3, analyzedFiles: 1, excludedFiles: 2 },
  languages: {
    byLanguage: [
      { language: "typescript", files: 1, bytes: 40, bestEffort: false },
    ],
    preferredCoverageOk: true,
  },
};

function publishWithCoverage(db: QaDb, coverage: CoverageReport | null): void {
  publishGeneration(db, {
    generationId: GENERATION_ID,
    files:
      coverage === null
        ? {}
        : { "coverage.json": `${JSON.stringify(coverage, null, 2)}\n` },
  });
}

describe("coverage report rendered by the reader", () => {
  it("never renders complete beside gaps, even when the payload claims it", async () => {
    const db = open();
    publishWithCoverage(db, {
      ...COVERAGE_BASE,
      // The inconsistent payload: `complete:true` with gaps.
      complete: true,
      gaps: [
        {
          path: ".env",
          reason: "excluded_secret",
          bytes: 12,
          detail: "疑似密钥文件",
        },
        {
          path: "node_modules/left-pad/index.js",
          reason: "excluded_default_dir",
          bytes: 2048,
        },
      ],
    } as unknown as CoverageReport);

    const html = await page(
      db,
      new URL(`/learn/reader?generation=${GENERATION_ID}`, "http://localhost"),
    );
    expect(countTestId(html, "coverage-gaps")).toBe(1);
    expect(html).toContain('data-complete="false"');
    expect(html).not.toContain('data-complete="true"');
    expect(html).toContain('data-path=".env"');
    expect(html).toContain('data-reason="excluded_secret"');
    expect(html).toContain("疑似密钥");
    expect(html).toContain("node_modules/left-pad/index.js");
    expect(html).toContain("覆盖不完整");
    expect(html).toContain("已分析 1 / 3 个文件，排除 2 个。");
  });

  it("renders complete only for a report with no gaps", async () => {
    const db = open();
    publishWithCoverage(db, {
      ...COVERAGE_BASE,
      complete: true,
      gaps: [],
    } as unknown as CoverageReport);

    const html = await page(
      db,
      new URL(`/learn/reader?generation=${GENERATION_ID}`, "http://localhost"),
    );
    expect(html).toContain('data-complete="true"');
    expect(html).toContain("覆盖报告：未记录未分析路径。");
  });

  it("treats a generation without a coverage file as unknown, not complete", async () => {
    const db = open();
    publishWithCoverage(db, null);

    const html = await page(
      db,
      new URL(`/learn/reader?generation=${GENERATION_ID}`, "http://localhost"),
    );
    expect(html).toContain('data-complete="false"');
    expect(html).toContain("没有可用的覆盖报告");
    expect(html).toContain("结论不覆盖整个仓库，绝不声称完整");
  });
});

describe("watch panel built from real project rows", () => {
  function seedProjects(db: QaDb): void {
    publishGeneration(db, { generationId: GENERATION_ID });
    if (db.repos.repos.byId(GITHUB_REPO) === null) {
      db.repos.repos.upsert(
        makeRepo({
          repoId: GITHUB_REPO,
          identity: "github:level8/fixture",
          kind: "github",
          mirrorPath: "/tmp/level8-fixture.git",
          remoteUrl: "https://github.com/level8/fixture",
        }),
      );
    }
    if (db.repos.projects.byId(GITHUB_PROJECT) === null) {
      db.repos.projects.insert(
        makeProject({
          projectId: GITHUB_PROJECT,
          repoId: GITHUB_REPO,
          kind: "github",
          displayName: "github-fixture",
          defaultBranch: "main",
          watchEnabled: true,
        }),
      );
    }
    db.repos.cursors.put({
      repoId: GITHUB_REPO,
      streamId: "default_branch",
      kind: "discovery",
      cursor: { ...emptyCursor("default_branch"), lastPollAt: AT },
      expectedPrevious: null,
    });
    db.repos.changes.insertMany([
      makeChange({
        eventId: "e_level8_watch" as never,
        projectId: GITHUB_PROJECT,
        repoId: GITHUB_REPO,
        discoveredAt: AT,
        state: "published",
        publishedAt: AT,
      }),
    ]);
  }

  it("enables the control for a GitHub project and reads its last poll", async () => {
    const db = open();
    seedProjects(db);

    const html = await page(
      db,
      new URL(`/settings?project=${GITHUB_PROJECT}`, "http://localhost"),
    );
    expect(html).toContain('data-available="true"');
    expect(html).toContain('data-enabled="true"');
    expect(html).toContain(`data-project-id="${GITHUB_PROJECT}"`);
    expect(html).toMatch(
      /<input[^>]*data-testid="settings-watch-toggle"[^>]*checked/u,
    );
    expect(html).toContain(`datetime="${AT}"`);
    // The manual refresh path the client posts to is present.
    expect(html).toContain('data-testid="settings-watch-refresh"');
    expect(html).toContain('data-refresh-now="true"');
  });

  it("disables the control for a local project with the contract reason", async () => {
    const db = open();
    seedProjects(db);

    const html = await page(
      db,
      new URL(`/settings?project=${PROJECT_ID}`, "http://localhost"),
    );
    expect(html).toContain('data-available="false"');
    expect(html).toContain('data-enabled="false"');
    expect(html).toContain("本地项目不支持后台轮询");
    expect(html).toMatch(
      /<input[^>]*data-testid="settings-watch-toggle"[^>]*disabled/u,
    );
    expect(html).toContain('data-testid="polling-note"');
    expect(html).toContain("force-push");
  });
});
