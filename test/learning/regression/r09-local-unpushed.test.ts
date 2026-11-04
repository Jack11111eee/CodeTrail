/**
 * AC-R09-01: a local commit (including an unpushed one) is analysable. The
 * uncommitted edit and the untracked file are excluded from the snapshot and
 * listed as coverage gaps, and neither the user's tree nor the analysis tree
 * changes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import {
  buildCoverageReport,
  type CoverageStatus,
} from "../../../src/learning/projects/coverage.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  createSnapshotReader,
  listTreeEntries,
} from "../../../src/learning/projects/worktree.ts";
import {
  fixtureGit,
  fixturePath,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "../projects/harness.ts";

const FIXTURE = "local-unpushed";
const GENERATION_ID = "g_r09_unpushed0001" as GenerationId;

let harness: ProjectsHarness | undefined;

beforeAll(() => {
  if (!fs.existsSync(path.join(fixturesDir(), "manifest.json"))) {
    throw new Error("fixtures are missing; run `pnpm run fixtures` first");
  }
  requireFixtures();
}, 180_000);

afterEach(() => {
  if (harness !== undefined) {
    restoreWritable(harness.paths.work);
    harness.close();
  }
  harness = undefined;
});

function sha256(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

/** Recursive `path -> sha256` map, ignoring `.git`. */
function fileMap(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join("/");
        result[relative] = sha256(absolute);
      }
    }
  };
  walk(root);
  return result;
}

/**
 * Import-time working-tree state → the two gap lists.
 *
 * Deliberately built from path-only Git commands: the shared helper trims
 * captured stdout, which would corrupt the two-column `git status` prefix (a
 * leading ` M` loses its first column and shifts every path by one character).
 */
function dirtyStatus(name: string): CoverageStatus {
  const lines = (output: string): string[] =>
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  // `git diff HEAD` covers both staged and unstaged edits against the commit
  // the snapshot is built from.
  const uncommitted = lines(fixtureGit(name, ["diff", "HEAD", "--name-only"]));
  const untracked = lines(
    fixtureGit(name, ["ls-files", "--others", "--exclude-standard"]),
  );
  return { uncommitted, untracked };
}

describe("AC-R09-01 — local unpushed commit", () => {
  it("analyses the selected commit, excludes local-only files and keeps both trees stable", async () => {
    harness = await createHarness();
    const userRepo = fixturePath(FIXTURE);
    const userBefore = fileMap(userRepo);
    const porcelainBefore = fixtureGit(FIXTURE, ["status", "--porcelain"]);

    const fixture = await cloneFixture(harness, FIXTURE);
    const headSha = fixtureGit(FIXTURE, ["rev-parse", "HEAD"]);
    const headTree = fixtureGit(FIXTURE, ["rev-parse", "HEAD^{tree}"]);
    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });

    // The selected local commit — including the unpushed one — is analysable.
    await expect(service.resolve(fixture.repo.repoId, headSha)).resolves.toBe(
      headSha,
    );
    const snapshot = await service.ensure(fixture.repo.repoId, headSha);
    expect(snapshot.commitSha).toBe(headSha);
    expect(snapshot.treeHash).toBe(headTree);

    const analysisBefore = fileMap(snapshot.worktreePath);
    const scope = normalizeScope();

    // A file introduced by the unpushed commit is analysed…
    await expect(
      service.readFile(snapshot, "src/pricing.ts", scope),
    ).resolves.toContain("priceOf");
    // …while the uncommitted edit never reaches the snapshot.
    const stock = await service.readFile(snapshot, "src/stock.ts", scope);
    expect(stock).not.toContain("Local edit that has not been committed");
    // …and the untracked file is neither copied nor listed.
    const listed = (await service.listFiles(snapshot, scope)).map(
      (entry) => entry.path,
    );
    expect(listed).toContain("src/pricing.ts");
    expect(listed).not.toContain("notes/local.md");
    expect(fs.existsSync(path.join(snapshot.worktreePath, "notes"))).toBe(
      false,
    );

    // The production coverage report lists both excluded paths as gaps.
    const entries = await listTreeEntries(
      snapshot.worktreePath,
      snapshot.commitSha,
    );
    const reader = createSnapshotReader(snapshot, scope);
    const report = await buildCoverageReport({
      generationId: GENERATION_ID,
      commitSha: snapshot.commitSha,
      scope,
      entries,
      readBlob: async (relPath) => (await reader.read(relPath)).slice(0, 512),
      status: dirtyStatus(FIXTURE),
    });
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/stock.ts",
          reason: "uncommitted_excluded",
        }),
        expect.objectContaining({
          path: "notes/local.md",
          reason: "untracked_excluded",
        }),
      ]),
    );
    expect(report.complete).toBe(false);
    expect(report.analyzed.map((entry) => entry.path)).not.toContain(
      "notes/local.md",
    );

    // Neither the user's repository nor the immutable analysis tree changed.
    expect(fileMap(userRepo)).toEqual(userBefore);
    expect(fixtureGit(FIXTURE, ["status", "--porcelain"])).toBe(
      porcelainBefore,
    );
    expect(fileMap(snapshot.worktreePath)).toEqual(analysisBefore);
  }, 120_000);
});
