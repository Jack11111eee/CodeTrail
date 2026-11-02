import { describe, expect, it } from "vitest";

import type { SemanticRepairFn } from "../../../src/learning/contracts/index.ts";
import {
  evaluateLesson,
  lessonPublishable,
} from "../../../src/learning/lessons/builder.ts";
import { validateDiagram } from "../../../src/learning/lessons/validate/diagram.ts";
import {
  failingMermaid,
  researchFixture,
} from "../helpers/lesson-context.ts";

const NO_REPAIR: SemanticRepairFn = ({ lesson }) => Promise.resolve(lesson);

/**
 * AC-LES-11: a genuine mermaid parse failure marks the structural check
 * `failed` and blocks publication. An unavailable parser is not a failure.
 */
describe("diagram mermaid", () => {
  it("accepts a diagram the mermaid port parses", async () => {
    const { lesson, ctx } = researchFixture();

    const result = await validateDiagram(lesson, ctx);

    expect(result.ok).toBe(true);
  });

  it("rejects a diagram the port reports as invalid", async () => {
    const { lesson, ctx } = researchFixture();
    const failing = { ...ctx, mermaid: failingMermaid("Invalid diagram") };

    const result = await validateDiagram(lesson, failing);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("diagram_mermaid");
    expect(result.issues[0]?.message).toContain("Invalid diagram");
  });

  it("sets checks.structural to failed and blocks publish", async () => {
    const { lesson, ctx } = researchFixture();
    const failing = { ...ctx, mermaid: failingMermaid() };

    const evaluated = await evaluateLesson(lesson, failing, NO_REPAIR);

    expect(evaluated.checks.structural).toBe("failed");
    expect(lessonPublishable(evaluated.checks)).toBe(false);
    expect(evaluated.issues.map((entry) => entry.code)).toContain(
      "diagram_mermaid",
    );
  });
});
