import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CoverageReport,
  GenerationId,
  SnapshotRecord,
  SnapshotService,
} from "../../../src/learning/contracts/index.ts";
import {
  evidenceSlicesFor,
  isBestEffort,
} from "../../../src/learning/projects/languages.ts";
import {
  languageOf,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import { listTreeEntries } from "../../../src/learning/projects/worktree.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "../projects/harness.ts";

/**
 * Integration: `SnapshotService` (issue-08) + read scope and coverage
 * (issue-11) + language/evidence slicing (issue-11).
 *
 * `coverage()` is the only report assembled from the immutable worktree, while
 * `listFiles()`/`readFile()` are the read surfaces a lesson builder uses. The
 * boundary assertions here are the ones neither module can make alone:
 * coverage partitions the committed tree, the analysed list agrees with the
 * readable listing, LFS pointers keep their bytes, and language slices line up
 * with the exact committed lines.
 */

const GENERATION = "g_integration" as GenerationId;

let harness: ProjectsHarness | undefined;
let service: SnapshotService | undefined;
let hygiene: SnapshotRecord | undefined;
let polyglot: SnapshotRecord | undefined;

async function snapshotOf(name: string): Promise<SnapshotRecord> {
  const fixture = await cloneFixture(harness!, name);
  return service!.ensure(fixture.repo.repoId, fixture.sha);
}

beforeEach(async () => {
  harness = await createHarness();
  service = createSnapshotService({
    paths: harness.paths,
    repos: harness.repos,
    clock: harness.clock,
  });
  hygiene = await snapshotOf("scope-hygiene");
  polyglot = await snapshotOf("polyglot");
});

afterEach(() => {
  if (harness !== undefined) {
    restoreWritable(harness.paths.work);
    harness.close();
  }
  harness = undefined;
  service = undefined;
  hygiene = undefined;
  polyglot = undefined;
});

async function hygieneReport(scope = normalizeScope()): Promise<CoverageReport> {
  return service!.coverage(hygiene!, scope, GENERATION);
}

describe("coverage partitions the committed tree", () => {
  it("puts every committed path in exactly one of analysed/gaps", async () => {
    const report = await hygieneReport();
    const analyzed = new Set(report.analyzed.map((entry) => entry.path));
    const gaps = new Map(report.gaps.map((gap) => [gap.path, gap]));

    // Nothing is silently dropped and nothing is double counted.
    for (const path of analyzed) {
      expect(gaps.has(path), `${path} must not be both analysed and a gap`).toBe(
        false,
      );
    }

    const entries = await listTreeEntries(hygiene!.worktreePath, hygiene!.commitSha);
    for (const entry of entries) {
      if (entry.type === "tree") continue;
      expect(
        analyzed.has(entry.path) || gaps.has(entry.path),
        `${entry.path} must be analysed or reported as a gap`,
      ).toBe(true);
    }

    // A `.gitmodules` declaration is reported even without a gitlink row.
    expect(entries.some((entry) => entry.path === "vendor")).toBe(false);
    expect(gaps.get("vendor")?.reason).toBe("submodule_not_fetched");

    expect(report.counts.analyzedFiles).toBe(analyzed.size);
    expect(report.counts.excludedFiles).toBe(gaps.size);
    expect(report.counts.totalFiles).toBe(analyzed.size + gaps.size);
    expect(report.complete).toBe(false);
  });

  it("agrees with the readable listing about every in-scope file", async () => {
    const report = await hygieneReport();
    const listed = (await service!.listFiles(hygiene!, normalizeScope())).map(
      (entry) => entry.path,
    );
    const lfsPointers = report.gaps
      .filter((gap) => gap.reason === "lfs_not_fetched")
      .map((gap) => gap.path);
    const analyzed = report.analyzed.map((entry) => entry.path);

    // `listFiles` is a readability view, so it still sees the LFS pointer;
    // the coverage report is the analysis view and excludes it. They must
    // differ by exactly the LFS pointer set, never by a silently dropped file.
    expect([...analyzed].sort()).toEqual(
      listed.filter((entry) => !lfsPointers.includes(entry)).sort(),
    );
    expect(listed).toContain("src/app.py");
    expect(listed).toContain(".gitmodules");
    for (const excluded of [
      ".env",
      "model.bin",
      "dist/bundle.js",
      "node_modules/left-pad/index.js",
      "weights/model.pt",
      "weights/model.safetensors",
    ]) {
      expect(listed, excluded).not.toContain(excluded);
    }
  });

  it("keeps the LFS pointer bytes and never materializes the submodule", async () => {
    const report = await hygieneReport();
    const gap = report.gaps.find((entry) => entry.path === "assets/model.lfs");
    expect(gap?.reason).toBe("lfs_not_fetched");

    const pointer = fs.readFileSync(
      path.join(hygiene!.worktreePath, "assets/model.lfs"),
      "utf8",
    );
    expect(pointer.startsWith("version https://git-lfs.github.com/spec/v1")).toBe(
      true,
    );
    expect(
      await service!.readFile(hygiene!, "assets/model.lfs", normalizeScope()),
    ).toBe(pointer);
    expect(gap?.bytes).toBe(Buffer.byteLength(pointer));

    const vendor = path.join(hygiene!.worktreePath, "vendor");
    const materialized =
      fs.existsSync(vendor) && fs.readdirSync(vendor).length > 0;
    expect(materialized, "submodule must not be checked out").toBe(false);
  });

  it("narrows analysed entries and read access together", async () => {
    const narrow = normalizeScope({
      include: ["src/**"],
      exclude: ["src/vendor/**"],
    });
    expect(narrow.hash).not.toBe(normalizeScope().hash);

    const wide = await hygieneReport();
    const report = await hygieneReport(narrow);
    expect(report.analyzed.map((entry) => entry.path)).toEqual(["src/app.py"]);
    expect(report.gaps.find((gap) => gap.path === "README.md")?.reason).toBe(
      "excluded_by_scope",
    );

    const wideSet = new Set(wide.analyzed.map((entry) => entry.path));
    for (const entry of report.analyzed) {
      expect(wideSet.has(entry.path), entry.path).toBe(true);
    }
    await expect(
      service!.readFile(hygiene!, "README.md", narrow),
    ).rejects.toMatchObject({ code: "out_of_scope_path" });
  });
});

describe("language coverage through the snapshot", () => {
  it("labels the polyglot languages and marks Go best-effort (AC-PRJ-17)", async () => {
    const report = await service!.coverage(
      polyglot!,
      normalizeScope(),
      GENERATION,
    );
    const byPath = new Map(
      report.analyzed.map((entry) => [entry.path, entry.language]),
    );
    expect(byPath.get("python/main.py")).toBe("python");
    expect(byPath.get("java/Main.java")).toBe("java");
    expect(byPath.get("ts/app.ts")).toBe("typescript");
    expect(byPath.get("vue/App.vue")).toBe("vue");
    expect(byPath.get("go/main.go")).toBe("go");
    expect(byPath.get("README.md")).toBe("other");

    const byLanguage = new Map(
      report.languages.byLanguage.map((entry) => [entry.language, entry]),
    );
    expect(byLanguage.get("go")?.bestEffort).toBe(true);
    expect(byLanguage.get("other")?.bestEffort).toBe(true);
    for (const language of ["python", "java", "typescript", "vue"] as const) {
      expect(byLanguage.get(language)?.bestEffort, language).toBe(false);
    }
  });

  it("splits a Vue SFC read from the snapshot into exact 1-based regions", async () => {
    const source = await service!.readFile(
      polyglot!,
      "vue/App.vue",
      normalizeScope(),
    );
    const slices = evidenceSlicesFor("vue/App.vue", source);
    expect(slices).toHaveLength(3);
    expect(slices.map((slice) => slice.region)).toEqual([
      "script",
      "template",
      "style",
    ]);

    const lines = source.split(/\r?\n/u);
    const textOf = (slice: (typeof slices)[number]) =>
      lines.slice(slice.startLine - 1, slice.endLine).join("\n");
    expect(textOf(slices[0]!)).toContain("const label");
    expect(textOf(slices[1]!)).toContain("<p>");
    expect(textOf(slices[2]!)).toContain("color: #333");

    for (const slice of slices) {
      expect(slice.startLine).toBeGreaterThanOrEqual(1);
      expect(slice.endLine).toBeGreaterThanOrEqual(slice.startLine);
      expect(slice.endLine).toBeLessThanOrEqual(lines.length);
      expect(slice.bestEffort).toBe(isBestEffort(languageOf(slice.path)));
    }

    // The Go file is readable but flagged best-effort on the same path.
    const go = await service!.readFile(polyglot!, "go/main.go", normalizeScope());
    const [goSlice] = evidenceSlicesFor("go/main.go", go);
    expect(goSlice?.bestEffort).toBe(true);
    expect(goSlice?.region).toBe("file");
  });
});
