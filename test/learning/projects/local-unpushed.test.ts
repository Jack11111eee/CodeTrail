import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { worktreePath } from "../../../src/learning/config/paths.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import { fixtureGit } from "../helpers/git-fixture.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "./harness.ts";

/**
 * AC-PRJ-06: a local repository with unpushed commits is analysed at its
 * branch head, and neither the uncommitted edit nor the untracked file can
 * reach the worktree or the readable source list.
 */
describe("local unpushed head", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    if (harness !== undefined) {
      // Snapshots are chmod'ed read-only; restore before the temp dir is removed.
      restoreWritable(harness.paths.work);
      harness.close();
    }
    harness = undefined;
  });

  it("resolves, ensures and reads the local head without local-only files", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "local-unpushed");
    const expectedSha = fixtureGit("local-unpushed", ["rev-parse", "HEAD"]);
    const expectedTree = fixtureGit("local-unpushed", [
      "rev-parse",
      "HEAD^{tree}",
    ]);

    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });

    // The unpushed commit is in the mirror and is a valid branch head.
    const resolved = await service.resolve(fixture.repo.repoId, "main");
    expect(resolved).toBe(expectedSha);

    const snapshot = await service.ensure(fixture.repo.repoId, resolved);
    expect(snapshot.commitSha).toBe(expectedSha);
    expect(snapshot.treeHash).toBe(expectedTree);
    expect(snapshot.worktreePath).toBe(
      worktreePath(harness.paths, fixture.repo.repoId, expectedSha),
    );

    const scope = normalizeScope();

    // A file introduced by the unpushed commit is analysed.
    expect(await service.readFile(snapshot, "src/pricing.ts", scope)).toContain(
      "priceOf",
    );

    // The committed version of src/stock.ts is what the snapshot holds — not
    // the working-tree edit that was never committed.
    const stock = await service.readFile(snapshot, "src/stock.ts", scope);
    expect(stock).not.toContain("Local edit that has not been committed");
    expect(
      fs.readFileSync(path.join(snapshot.worktreePath, "src/stock.ts"), "utf8"),
    ).toBe(stock);

    // The untracked notes/ directory never reaches the worktree or the list.
    const files = await service.listFiles(snapshot, scope);
    const paths = files.map((entry) => entry.path);
    expect(paths).toContain("src/pricing.ts");
    expect(paths).not.toContain("notes/local.md");
    expect(fs.existsSync(path.join(snapshot.worktreePath, "notes"))).toBe(
      false,
    );

    // The mirror keeps the unpushed commit object, not the working tree.
    expect(
      fs.existsSync(path.join(snapshot.worktreePath, "src/stock.ts")),
    ).toBe(true);
  });
});
