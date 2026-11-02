import { describe, expect, it } from "vitest";

import {
  codeFactCount,
  validateLabels,
} from "../../../src/learning/lessons/validate/labels.ts";
import {
  researchFixture,
  teachingExampleRef,
} from "../helpers/lesson-context.ts";

/**
 * AC-LES-15: the scenario is explicitly an example, and a `teaching_example`
 * is never counted as a code fact.
 */
describe("example labelling", () => {
  it("accepts an explicitly labelled example scenario", () => {
    const { lesson, ctx } = researchFixture();

    expect(lesson.scenario.isExample).toBe(true);
    expect(validateLabels(lesson, ctx).ok).toBe(true);
  });

  it("excludes teaching_example statements from the code-fact count", () => {
    const { lesson } = researchFixture();
    const before = codeFactCount(lesson);

    const withExample = structuredClone(lesson);
    withExample.statements.push({
      id: "st2",
      label: "teaching_example",
      text: "示例：输入 ` Hello ` 得到 `hello`。",
      evidenceIds: [teachingExampleRef().sourceId],
    });

    expect(codeFactCount(withExample)).toBe(before);
  });

  it("rejects a scenario that is not labelled as an example", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson) as unknown as Record<string, unknown>;
    (broken.scenario as Record<string, unknown>).isExample = false;

    const result = validateLabels(broken as never, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("example_label");
  });
});
