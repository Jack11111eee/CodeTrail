import { describe, expect, it } from "vitest";

import { validateStructural } from "../../../src/learning/lessons/validate/structural.ts";
import { researchFixture } from "../helpers/lesson-context.ts";

/**
 * AC-LES-03: the plain and technical layers describe the same mechanism ids in
 * different words, and both layers share the lesson's evidence set.
 */
describe("layering", () => {
  it("accepts the canonical two-layer lesson", () => {
    const { lesson, ctx } = researchFixture();

    const result = validateStructural(lesson, ctx);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a mechanism that appears in only one layer", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.plainExplanation.push({
      mechanismId: "m2",
      text: "只在通俗层出现的机制。",
    });

    const result = validateStructural(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("layering");
    expect(result.issues[0]?.message).toContain("m2");
  });

  it("rejects identical text in both layers", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.technicalExplanation[0].text = broken.plainExplanation[0].text;

    const result = validateStructural(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("layering");
  });
});
