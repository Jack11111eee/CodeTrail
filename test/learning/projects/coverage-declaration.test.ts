import { afterEach, describe, expect, it } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import { buildCoverageReport } from "../../../src/learning/projects/coverage.ts";
import { isBestEffort } from "../../../src/learning/projects/languages.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "./harness.ts";
import { blob, reportForFixture } from "./scope-fixtures.ts";

const GENERATION = "g_test" as GenerationId;
const COMMIT = "b".repeat(40);

function input(
  entries: { path: string; bytes: number; mode: string; type: string }[],
  scope = normalizeScope(),
) {
  return {
    generationId: GENERATION,
    commitSha: COMMIT,
    scope,
    entries,
    readBlob: () => Promise.resolve("plain text\n"),
  };
}

/**
 * AC-PRJ-16: `complete` is derived from the report's own gaps, counts and the
 * language report stay consistent with the analysed list, and `maxFiles`
 * overflow becomes gaps instead of disappearing.
 */
describe("completeness is computed, never supplied", () => {
  it("is true exactly when there are no gaps", async () => {
    const clean = await buildCoverageReport(input([blob("src/app.py")]));
    expect(clean.gaps).toEqual([]);
    expect(clean.complete).toBe(true);

    const dirty = await buildCoverageReport(input([blob(".env")]));
    expect(dirty.gaps.length).toBeGreaterThan(0);
    expect(dirty.complete).toBe(false);

    const empty = await buildCoverageReport(input([]));
    expect(empty.gaps).toEqual([]);
    expect(empty.complete).toBe(true);
  });

  it("holds across the real fixtures", async () => {
    for (const fixture of ["scope-hygiene", "polyglot"]) {
      const { report } = await reportForFixture(fixture, normalizeScope());
      expect(report.complete, fixture).toBe(report.gaps.length === 0);
    }
  });

  it("cannot produce complete:true with non-empty gaps", async () => {
    const scopes = [
      normalizeScope(),
      normalizeScope({ include: [] }),
      normalizeScope({ maxFiles: 0 }),
      normalizeScope({ exclude: ["**/*"] }),
    ];
    for (const scope of scopes) {
      const { report } = await reportForFixture("scope-hygiene", scope);
      expect(report.complete).toBe(report.gaps.length === 0);
      if (report.complete) {
        expect(report.gaps).toEqual([]);
      }
    }
  });
});

describe("counts and language report", () => {
  it("keeps counts equal to the analysed plus excluded lists", async () => {
    const report = await buildCoverageReport(
      input([
        blob("src/app.py"),
        blob("src/util.py"),
        blob(".env"),
        blob("dist/x.js"),
      ]),
    );
    expect(report.counts.analyzedFiles).toBe(2);
    expect(report.counts.excludedFiles).toBe(2);
    expect(report.counts.totalFiles).toBe(4);

    const { report: polyglot } = await reportForFixture(
      "polyglot",
      normalizeScope(),
    );
    expect(polyglot.counts.totalFiles).toBe(
      polyglot.counts.analyzedFiles + polyglot.counts.excludedFiles,
    );
    expect(
      polyglot.languages.byLanguage.reduce((sum, item) => sum + item.files, 0),
    ).toBe(polyglot.counts.analyzedFiles);
    expect(
      polyglot.languages.byLanguage.reduce((sum, item) => sum + item.bytes, 0),
    ).toBe(polyglot.analyzed.reduce((sum, entry) => sum + entry.bytes, 0));
  });

  it("marks every non-preferred language best-effort", async () => {
    const { report } = await reportForFixture("polyglot", normalizeScope());
    const byLanguage = new Map(
      report.languages.byLanguage.map((entry) => [entry.language, entry]),
    );
    for (const language of ["python", "java", "typescript", "vue"] as const) {
      expect(byLanguage.get(language)?.bestEffort, language).toBe(false);
    }
    expect(byLanguage.get("go")?.bestEffort).toBe(true);
    expect(byLanguage.get("other")?.bestEffort).toBe(true);
    // `polyglot` has no JavaScript file, so preferred coverage is incomplete.
    expect(report.languages.preferredCoverageOk).toBe(false);
  });

  it("reports preferred coverage only when python, java, ts, js and vue exist", async () => {
    const report = await buildCoverageReport(
      input([
        blob("python/main.py"),
        blob("java/Main.java"),
        blob("ts/app.ts"),
        blob("js/app.js"),
        blob("vue/App.vue"),
      ]),
    );
    expect(report.languages.preferredCoverageOk).toBe(true);
    expect(report.languages.byLanguage).toHaveLength(5);
    for (const entry of report.languages.byLanguage) {
      expect(entry.bestEffort).toBe(isBestEffort(entry.language));
      expect(entry.files).toBe(1);
    }
  });

  it("returns an empty language report for an empty repository", async () => {
    const report = await buildCoverageReport(input([]));
    expect(report.counts).toEqual({
      totalFiles: 0,
      analyzedFiles: 0,
      excludedFiles: 0,
    });
    expect(report.languages.byLanguage).toEqual([]);
    expect(report.languages.preferredCoverageOk).toBe(false);
  });
});

describe("maxFiles", () => {
  it("turns overflow into gaps instead of dropping entries", async () => {
    const entries = [blob("a.py"), blob("b.py"), blob("c.py")];
    const report = await buildCoverageReport(
      input(entries, normalizeScope({ maxFiles: 2 })),
    );
    expect(report.analyzed.map((entry) => entry.path)).toEqual([
      "a.py",
      "b.py",
    ]);
    expect(report.gaps).toEqual([
      expect.objectContaining({
        path: "c.py",
        reason: "excluded_by_scope",
        detail: "max_files_exceeded",
      }),
    ]);
    expect(report.complete).toBe(false);
  });

  it("excludes everything when maxFiles is zero", async () => {
    const report = await buildCoverageReport(
      input([blob("a.py"), blob("b.py")], normalizeScope({ maxFiles: 0 })),
    );
    expect(report.analyzed).toEqual([]);
    expect(report.gaps.map((gap) => gap.path)).toEqual(["a.py", "b.py"]);
  });
});

describe("SnapshotService.coverage round-trip", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    if (harness !== undefined) {
      restoreWritable(harness.paths.work);
      harness.close();
    }
    harness = undefined;
  });

  it("produces the same report from the immutable worktree", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "scope-hygiene");
    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });
    const snapshot = await service.ensure(fixture.repo.repoId, fixture.sha);
    const report = await service.coverage(
      snapshot,
      normalizeScope(),
      GENERATION,
    );

    expect(report.generationId).toBe(GENERATION);
    expect(report.commitSha).toBe(fixture.sha);
    expect(report.complete).toBe(false);
    expect(report.analyzed.some((entry) => entry.path === ".env")).toBe(false);
    expect(report.gaps.find((gap) => gap.path === ".env")?.reason).toBe(
      "excluded_secret",
    );
    expect(report.gaps.find((gap) => gap.path === "vendor")?.reason).toBe(
      "submodule_not_fetched",
    );
  });
});
