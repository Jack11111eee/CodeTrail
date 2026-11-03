import { afterEach, describe, expect, it } from "vitest";

import {
  diffBetween,
  parseNameStatus,
} from "../../../src/learning/updates/diff.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-22: the persisted changed-file set equals the local
 * `git diff --name-status` even when GitHub's `/compare` is truncated at 300
 * files; a missing object records a gap rather than a silent truncation.
 */
describe("local diff computation", () => {
  let harness: UpdateHarness | undefined;
  let fake: FakeGithub | undefined;

  afterEach(async () => {
    cleanupHarness(harness);
    harness = undefined;
    await fake?.close();
    fake = undefined;
  });

  it("computes all 400 changed files from local objects", async () => {
    harness = await createUpdateHarness();
    for (let index = 0; index < 400; index += 1) {
      harness.git.write(
        `src/file-${String(index).padStart(4, "0")}.ts`,
        `export const v = 1;\n`,
      );
    }
    const base = harness.git.commit("feat: base files");
    for (let index = 0; index < 400; index += 1) {
      harness.git.write(
        `src/file-${String(index).padStart(4, "0")}.ts`,
        `export const v = 2;\n`,
      );
    }
    const head = harness.git.commit("feat: change all files");

    const mirror = {
      repoId: harness.repo.repoId,
      path: harness.git.path,
      identity: harness.repo.identity,
    };
    const diff = await diffBetween(mirror, base, head, { maxFiles: 5_000 });
    expect(diff.entries).toHaveLength(400);
    expect(diff.truncated).toBe(false);
    expect(diff.gaps).toHaveLength(0);

    const expected = parseNameStatus(
      harness.git.git(["diff", "--name-status", "-z", base, head]),
    );
    expect(diff.entries.map((entry) => entry.path).sort()).toEqual(
      expected.map((entry) => entry.path).sort(),
    );

    // GitHub's own compare response is capped at 300 files.
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      compareFiles: 400,
    });
    const response = await fetch(
      `${fake.baseUrl}/repos/acme/widgets/compare/${base}...${head}`,
    );
    const body = (await response.json()) as {
      files: unknown[];
      truncated: boolean;
    };
    expect(body.files).toHaveLength(300);
    expect(body.truncated).toBe(true);
    expect(diff.entries.length).toBeGreaterThan(body.files.length);
  });

  it("flags maxFiles truncation explicitly", async () => {
    harness = await createUpdateHarness();
    for (let index = 0; index < 12; index += 1) {
      harness.git.write(`src/many-${index}.ts`, `export const m = ${index};\n`);
    }
    const base = harness.git.commit("feat: many base");
    for (let index = 0; index < 12; index += 1) {
      harness.git.write(
        `src/many-${index}.ts`,
        `export const m = ${index + 1};\n`,
      );
    }
    const head = harness.git.commit("feat: many head");
    const diff = await diffBetween(
      {
        repoId: harness.repo.repoId,
        path: harness.git.path,
        identity: harness.repo.identity,
      },
      base,
      head,
      { maxFiles: 5 },
    );
    expect(diff.entries).toHaveLength(5);
    expect(diff.truncated).toBe(true);
  });
});
