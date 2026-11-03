import { afterEach, describe, expect, it } from "vitest";

import { classifySignificance } from "../../../src/learning/updates/change-lesson.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-23: wording/format-only changes produce `significance="short"`
 * records that still point at the original commit, and
 * `event count === discovered count`.
 */
describe("short record", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("classifies a prose-only edit as short and keeps the commit", async () => {
    harness = await createUpdateHarness();
    harness.git.write("README.md", "hello world\n");
    const base = harness.git.commit("docs: readme");
    await harness.tick();

    harness.git.write("README.md", "hello brave world\n");
    const head = harness.git.commit("docs: wording");
    const result = await harness.tick();

    const event = harness
      .events()
      .find((candidate) => candidate.headSha === head);
    expect(event?.significance).toBe("short");
    expect(event?.kind).toBe("commit");
    expect(event?.payload.commit?.firstParent).toBe(base);
    expect(harness.events()).toHaveLength(1 + result.discovered);
  });

  it("treats a comment-only code edit as wording", async () => {
    const significance = await classifySignificance(
      [{ path: "src/a.ts", status: "M" }],
      {
        readBase: () =>
          Promise.resolve("// old comment\nexport const a = 1;\n"),
        readHead: () =>
          Promise.resolve("// new comment\nexport const a = 1;\n"),
      },
    );
    expect(significance).toBe("short");
  });

  it("never drops the event even for a short record", async () => {
    harness = await createUpdateHarness();
    harness.git.write("README.md", "v1\n");
    harness.git.commit("docs: v1");
    await harness.tick();
    harness.git.write("README.md", "v2\n");
    const head = harness.git.commit("docs: v2");
    const result = await harness.tick();
    expect(result.discovered).toBe(1);
    expect(
      harness.events().filter((event) => event.headSha === head),
    ).toHaveLength(1);
    expect(
      harness.repos.changes.countByProject(harness.project.projectId),
    ).toBe(harness.events().length);
  });
});
