import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeScope } from "../../../src/learning/contracts/index.ts";
import { catFileExists } from "../../../src/learning/projects/mirror.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "./harness.ts";

/**
 * AC-PRJ-12: a snapshot worktree is read-only, and re-ensuring the same commit
 * reuses the very same directory.
 */
describe("snapshot immutability", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    if (harness !== undefined) {
      restoreWritable(harness.paths.work);
      harness.close();
    }
    harness = undefined;
  });

  it("rejects writes and reuses the worktree for the same commit", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "local-unpushed");
    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });

    const first = await service.ensure(fixture.repo.repoId, fixture.sha);
    const second = await service.ensure(fixture.repo.repoId, fixture.sha);

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.treeHash).toBe(first.treeHash);
    expect(second.resolvedAt).toBe(first.resolvedAt);
    expect(
      harness.repos.snapshots.byCommit(fixture.repo.repoId, fixture.sha),
    ).toEqual(first);

    // The commit object is present in the mirror.
    expect(await catFileExists(fixture.handle, fixture.sha)).toBe(true);

    const target = path.join(first.worktreePath, "README.md");
    const original = fs.readFileSync(target, "utf8");

    // Prove immutability by attempting real writes, not by inspecting modes.
    expect(() => fs.writeFileSync(target, "tampered")).toThrow();
    expect(() => fs.appendFileSync(target, "tampered")).toThrow();
    expect(() =>
      fs.writeFileSync(path.join(first.worktreePath, "new.txt"), "x"),
    ).toThrow();
    expect(() =>
      fs.mkdirSync(path.join(first.worktreePath, "new-dir")),
    ).toThrow();

    // No write bit remains, and the content is byte-identical.
    expect(fs.statSync(target).mode & 0o222).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(await service.readFile(first, "README.md", normalizeScope())).toBe(
      original,
    );
  });
});
