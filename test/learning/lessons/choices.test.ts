import { describe, expect, it } from "vitest";

import { validateStructural } from "../../../src/learning/lessons/validate/structural.ts";
import { researchFixture } from "../helpers/lesson-context.ts";

/**
 * AC-LES-04: empty choices require a reason; every alternative carries
 * `whenItFits`, `cost` and evidence.
 */
describe("choices", () => {
  it("accepts a choice whose alternative has all three fields", () => {
    const { lesson, ctx } = researchFixture();

    expect(validateStructural(lesson, ctx).ok).toBe(true);
  });

  it("accepts empty choices with a non-empty reason", () => {
    const { lesson, ctx } = researchFixture();
    const valid = structuredClone(lesson);
    valid.choices = [];
    valid.choicesOmittedReason = "这个模块没有可比较的替代方案";

    expect(validateStructural(valid, ctx).ok).toBe(true);
  });

  it("rejects empty choices without a reason", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.choices = [];
    broken.choicesOmittedReason = null;

    const result = validateStructural(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("choices");
  });

  it("rejects an alternative without evidence", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.choices[0].alternatives[0].evidenceIds = [];

    const result = validateStructural(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("choices");
    expect(result.issues[0]?.message).toContain("evidence");
  });

  it.each(["whenItFits", "cost"] as const)(
    "rejects an alternative whose %s is blank",
    (field) => {
      const { lesson, ctx } = researchFixture();
      const broken = structuredClone(lesson);
      (broken.choices[0].alternatives[0] as unknown as Record<string, unknown>)[
        field
      ] = "   ";

      const result = validateStructural(broken, ctx);

      expect(result.ok).toBe(false);
      expect(result.issues.map((entry) => entry.code)).toContain("choices");
      expect(result.issues.some((entry) => entry.message.includes(field))).toBe(
        true,
      );
    },
  );
});
