import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureBuildWorktree,
  ensureWorktree,
  removeBuildWorktree,
} from "../../../src/learning/projects/worktree.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "./harness.ts";

let harness: ProjectsHarness | undefined;
afterEach(() => {
  if (harness) {
    restoreWritable(harness.paths.work);
    restoreWritable(harness.paths.staging);
    harness.close();
  }
  harness = undefined;
});

describe("real Git build worktree retry", () => {
  it("recreates a removed build tree at the same job path without disturbing the immutable snapshot", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "local-unpushed");
    const snapshot = await ensureWorktree(
      harness.paths,
      fixture.handle,
      fixture.sha,
    );
    const readme = fs.readFileSync(
      path.join(snapshot.path, "README.md"),
      "utf8",
    );
    const jobId = "j_retry_worktree" as never;
    const first = await ensureBuildWorktree(
      harness.paths,
      fixture.handle,
      fixture.sha,
      jobId,
    );
    fs.writeFileSync(
      path.join(first.path, "partial-output.txt"),
      "unfinished generation",
    );
    await removeBuildWorktree(harness.paths, jobId);
    expect(fs.existsSync(first.path)).toBe(false);
    const retried = await ensureBuildWorktree(
      harness.paths,
      fixture.handle,
      fixture.sha,
      jobId,
    );
    expect(retried.path).toBe(first.path);
    expect(fs.existsSync(path.join(retried.path, "partial-output.txt"))).toBe(
      false,
    );
    expect(fs.readFileSync(path.join(retried.path, "README.md"), "utf8")).toBe(
      readme,
    );
    expect(fs.readFileSync(path.join(snapshot.path, "README.md"), "utf8")).toBe(
      readme,
    );
    expect(fs.statSync(snapshot.path).mode & 0o222).toBe(0);
    await removeBuildWorktree(harness.paths, jobId);
    await expect(
      ensureBuildWorktree(harness.paths, fixture.handle, fixture.sha, jobId),
    ).resolves.toEqual(first);
  });
});
