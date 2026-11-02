import { afterEach, describe, expect, it } from "vitest";

import { normalizeScope } from "../../../src/learning/contracts/index.ts";
import { git } from "../../../src/learning/projects/git.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import { resolveRef } from "../../../src/learning/projects/worktree.ts";
import { fixtureGit } from "../helpers/git-fixture.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "./harness.ts";

/**
 * AC-PRJ-08: branch, tag, full SHA and unique short SHA all resolve to a full
 * 40-hex SHA; an unknown ref is `invalid_input` with `reason="unknown_ref"`.
 */
describe("ref resolution", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    if (harness !== undefined) {
      restoreWritable(harness.paths.work);
      harness.close();
    }
    harness = undefined;
  });

  it("resolves every documented ref form to the same full SHA", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "evolution");
    const head = fixtureGit("evolution", ["rev-parse", "HEAD"]);
    const previous = fixtureGit("evolution", ["rev-parse", "HEAD~1"]);
    expect(head).not.toBe(previous);

    // Tags live in the mirror just like any other ref.
    expect((await git(fixture.handle.path, ["tag", "v1.0.0", head])).code).toBe(
      0,
    );
    expect(
      (await git(fixture.handle.path, ["tag", "v0.9.0", previous])).code,
    ).toBe(0);

    expect(await resolveRef(fixture.handle, "main")).toBe(head);
    expect(await resolveRef(fixture.handle, "v1.0.0")).toBe(head);
    expect(await resolveRef(fixture.handle, "v0.9.0")).toBe(previous);
    expect(await resolveRef(fixture.handle, head)).toBe(head);
    expect(await resolveRef(fixture.handle, head.slice(0, 8))).toBe(head);

    // The service exposes the same resolution and stores the full SHA.
    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });
    const resolved = await service.resolve(fixture.repo.repoId, "v0.9.0");
    expect(resolved).toBe(previous);

    const snapshot = await service.ensure(fixture.repo.repoId, resolved);
    expect(snapshot.commitSha).toBe(previous);
    expect(
      await service.readFile(snapshot, "README.md", normalizeScope()),
    ).toBeTypeOf("string");
  });

  it("rejects an unknown ref with invalid_input/unknown_ref", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "evolution");

    for (const ref of [
      "no-such-branch",
      "0123456789abcdef0123456789abcdef01234567",
      "deadbeef",
      "",
      "--help",
    ]) {
      await expect(resolveRef(fixture.handle, ref)).rejects.toMatchObject({
        code: "invalid_input",
        details: { reason: "unknown_ref" },
      });
    }
  });
});
