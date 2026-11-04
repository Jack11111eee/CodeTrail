import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import { fixtureGit, fixturePath } from "../helpers/git-fixture.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  type ProjectsHarness,
} from "./harness.ts";

function sha256(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

/** Recursive `path -> sha256` map of the user's working tree, ignoring `.git`. */
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

function porcelain(name: string): string {
  return fixtureGit(name, ["status", "--porcelain"]);
}

/**
 * AC-PRJ-07: importing and snapshotting a local repository never writes to it.
 */
describe("no writes to the user repository", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    if (harness !== undefined) {
      restoreWritable(harness.paths.work);
      harness.close();
    }
    harness = undefined;
  });

  it("leaves the recursive file map and git status unchanged", async () => {
    harness = await createHarness();
    const userRepo = fixturePath("local-unpushed");

    const beforeFiles = fileMap(userRepo);
    const beforeStatus = porcelain("local-unpushed");

    const fixture = await cloneFixture(harness, "local-unpushed");
    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });
    const sha = await service.resolve(fixture.repo.repoId, "main");
    const snapshot = await service.ensure(fixture.repo.repoId, sha);
    await service.readFile(snapshot, "src/pricing.ts", normalizeScope());
    await service.listFiles(snapshot, normalizeScope());

    const afterFiles = fileMap(userRepo);
    expect(afterFiles).toEqual(beforeFiles);
    expect(porcelain("local-unpushed")).toBe(beforeStatus);

    // No tooling file may be added to the user's repository (AC-PRJ-07).
    expect(
      fs.existsSync(
        path.join(userRepo, ".github", "workflows", "openwiki-update.yml"),
      ),
    ).toBe(false);
    expect(fs.existsSync(path.join(userRepo, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(userRepo, "CLAUDE.md"))).toBe(false);
    expect(beforeFiles).not.toHaveProperty("AGENTS.md");
    expect(beforeFiles).not.toHaveProperty("CLAUDE.md");
  });
});
