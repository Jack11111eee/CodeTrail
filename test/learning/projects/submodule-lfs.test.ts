import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import { buildCoverageReport } from "../../../src/learning/projects/coverage.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { blob, reportForFixture } from "./scope-fixtures.ts";

const GENERATION = "g_test" as GenerationId;
const COMMIT = "a".repeat(40);
const GITMODULES =
  '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.invalid/vendor.git\n';

/**
 * AC-PRJ-11: submodules and LFS pointers are reported as not fetched, are
 * never descended into, and the pointer bytes are left untouched.
 */
describe("submodules", () => {
  it("reports the .gitmodules-declared path even without a gitlink row", async () => {
    const { report } = await reportForFixture(
      "scope-hygiene",
      normalizeScope(),
    );
    const vendor = report.gaps.find((gap) => gap.path === "vendor");
    expect(vendor).toMatchObject({
      path: "vendor",
      reason: "submodule_not_fetched",
      bytes: 0,
    });
    expect(report.analyzed.some((entry) => entry.path === "vendor")).toBe(
      false,
    );
  });

  it("reports a mode-160000 gitlink as a submodule, ahead of the dir rule", async () => {
    const report = await buildCoverageReport({
      generationId: GENERATION,
      commitSha: COMMIT,
      scope: normalizeScope(),
      entries: [
        blob(".gitmodules", GITMODULES.length),
        blob("vendor", 0, { mode: "160000", type: "commit" }),
      ],
      readBlob: (relPath) =>
        Promise.resolve(relPath === ".gitmodules" ? GITMODULES : ""),
    });
    expect(report.gaps.find((gap) => gap.path === "vendor")?.reason).toBe(
      "submodule_not_fetched",
    );
    expect(report.analyzed.map((entry) => entry.path)).toEqual([".gitmodules"]);
  });

  it("never descends into a declared submodule", async () => {
    const report = await buildCoverageReport({
      generationId: GENERATION,
      commitSha: COMMIT,
      scope: normalizeScope({ include: ["**/*"] }),
      entries: [
        blob(".gitmodules", GITMODULES.length),
        blob("vendor/lib/index.ts", 30),
      ],
      readBlob: (relPath) =>
        Promise.resolve(relPath === ".gitmodules" ? GITMODULES : ""),
    });
    expect(
      report.gaps.find((gap) => gap.path === "vendor/lib/index.ts")?.reason,
    ).toBe("submodule_not_fetched");
    expect(
      report.analyzed.some((entry) => entry.path.startsWith("vendor/")),
    ).toBe(false);
  });
});

describe("LFS", () => {
  it("reports a pointer as lfs_not_fetched and leaves the bytes unchanged", async () => {
    const pointerFile = path.join(
      fixturePath("scope-hygiene"),
      "assets/model.lfs",
    );
    const before = fs.readFileSync(pointerFile, "utf8");
    expect(before).toContain("version https://git-lfs.github.com/spec/v1");

    const { report } = await reportForFixture(
      "scope-hygiene",
      normalizeScope(),
    );

    const gap = report.gaps.find((entry) => entry.path === "assets/model.lfs");
    expect(gap?.reason).toBe("lfs_not_fetched");
    expect(gap?.bytes).toBeGreaterThan(0);
    expect(
      report.analyzed.some((entry) => entry.path === "assets/model.lfs"),
    ).toBe(false);
    expect(fs.readFileSync(pointerFile, "utf8")).toBe(before);
  });

  it("treats a non-pointer with the same extension as ordinary text", async () => {
    const report = await buildCoverageReport({
      generationId: GENERATION,
      commitSha: COMMIT,
      scope: normalizeScope(),
      entries: [blob("notes/plain.lfs", 10)],
      readBlob: () => Promise.resolve("not a pointer\n"),
    });
    expect(report.analyzed.map((entry) => entry.path)).toEqual([
      "notes/plain.lfs",
    ]);
    expect(report.gaps).toEqual([]);
    expect(report.complete).toBe(true);
  });
});

describe("import-time status", () => {
  it("reports uncommitted and untracked paths as gaps", async () => {
    const report = await buildCoverageReport({
      generationId: GENERATION,
      commitSha: COMMIT,
      scope: normalizeScope(),
      entries: [blob("src/app.py", 10)],
      readBlob: () => Promise.resolve("print('ok')\n"),
      status: {
        uncommitted: ["src/app.py"],
        untracked: ["notes/"],
      },
    });
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/app.py",
          reason: "uncommitted_excluded",
        }),
        expect.objectContaining({
          path: "notes",
          reason: "untracked_excluded",
        }),
      ]),
    );
    expect(report.complete).toBe(false);
  });
});
