import { afterEach, describe, expect, it } from "vitest";

import {
  diffBetween,
  readDeletedFile,
} from "../../../src/learning/updates/diff.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-11: the event records `head_sha`, `base_head_sha` and
 * `merge_base_sha`; the diff runs merge-base → head (not base tip → head) and
 * preview sources come from the head commit.
 */
describe("pull request diff direction", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("computes the diff from the merge base and previews the head", async () => {
    harness = await createUpdateHarness();
    harness.git.write("src/app.ts", "export const value = 1;\n");
    harness.git.write("src/legacy.ts", "export const legacy = true;\n");
    const mergeBase = harness.git.commit("chore: base");

    // The base branch advances after the feature branched, so base tip and
    // merge base differ.
    harness.git.write("src/main-only.ts", "export const mainOnly = true;\n");
    harness.git.commit("feat: main only");
    const baseHead = harness.git.head("main");

    harness.git.git(["checkout", "-q", "-b", "feature", mergeBase]);
    harness.git.write("src/app.ts", "export const value = 2;\n");
    harness.git.write("src/feature.ts", "export const feature = true;\n");
    harness.git.remove("src/legacy.ts");
    const head = harness.git.commit("feat: feature work");
    harness.git.checkout("main");

    harness.github.setPulls([
      makePull({
        number: 5,
        headSha: head,
        baseHeadSha: baseHead,
        updatedAt: "2024-06-01T00:15:00.000Z",
      }),
    ]);
    await harness.tick();

    const event = harness
      .events()
      .find((candidate) => candidate.kind === "pull_request");
    expect(event).toBeDefined();
    expect(event?.headSha).toBe(head);
    expect(event?.baseSha).toBe(mergeBase);
    expect(event?.mergeBaseSha).toBe(mergeBase);
    expect(event?.baseContextSha).toBe(baseHead);
    expect(event?.payload.pr?.baseHeadSha).toBe(baseHead);
    expect(event?.payload.pr?.mergeBaseSha).toBe(mergeBase);

    const diff = await diffBetween(
      {
        repoId: harness.repo.repoId,
        path: harness.git.path,
        identity: harness.repo.identity,
      },
      mergeBase,
      head,
      { maxFiles: 100 },
    );
    const paths = diff.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(["src/app.ts", "src/feature.ts", "src/legacy.ts"]);
    expect(paths).not.toContain("src/main-only.ts");

    const deleted = await readDeletedFile(
      {
        repoId: harness.repo.repoId,
        path: harness.git.path,
        identity: harness.repo.identity,
      },
      mergeBase,
      "src/legacy.ts",
    );
    expect(deleted).toContain("legacy");
  });
});
