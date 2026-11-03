import { afterEach, describe, expect, it } from "vitest";

import {
  classifySignificance,
  classifySignificancePaths,
} from "../../../src/learning/updates/change-lesson.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-24: editing `config.toml` or a schema file yields
 * `significance="full"` with behaviour-impact analysis; a formatting-only
 * config edit is never downgraded by its suffix or content.
 */
describe("config change is always full", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("keeps config.toml full even for whitespace-only edits", async () => {
    harness = await createUpdateHarness();
    harness.git.write("config.toml", "value = 1\n");
    harness.git.commit("chore: config");
    await harness.tick();

    harness.git.write("config.toml", "value  =  1   # spacing only\n");
    const head = harness.git.commit("chore: config spacing");
    await harness.tick();

    const event = harness
      .events()
      .find((candidate) => candidate.headSha === head);
    expect(event?.significance).toBe("full");
  });

  it("keeps schema files full regardless of suffix heuristics", async () => {
    const significance = await classifySignificance(
      [{ path: "db/schema.sql", status: "M" }],
      {
        readBase: () => Promise.resolve("-- old\nCREATE TABLE t (id INT);\n"),
        readHead: () => Promise.resolve("-- new\nCREATE TABLE t (id INT);\n"),
      },
    );
    expect(significance).toBe("full");

    expect(
      classifySignificancePaths([{ path: "config/app.yaml", status: "M" }]),
    ).toBe("full");
    expect(
      classifySignificancePaths([{ path: "src/app.ts", status: "M" }]),
    ).toBe("full");
  });
});
