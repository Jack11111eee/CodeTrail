import { describe, expect, it } from "vitest";

import {
  AnyLessonSchema,
  ChangeLessonSchema,
  ComparisonLessonSchema,
  LessonSchema,
  REQUIRED_LESSON_GROUPS,
  parseLesson,
  schemaForKind,
} from "../../../src/learning/lessons/schema.ts";
import {
  changeLesson,
  clone,
  comparisonLesson,
  researchLesson,
} from "../helpers/lesson-sample.ts";

const SAMPLES = [
  ["research", researchLesson],
  ["change", changeLesson],
  ["comparison", comparisonLesson],
] as const;

/**
 * AC-LES-01: the canonical sample passes, every required group is present and
 * checked independently, and each kind is validated by its own schema.
 */
describe("canonical lessons", () => {
  it.each(SAMPLES)("%s lesson parses", (_kind, make) => {
    const result = parseLesson(make());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lesson.kind).toBe(_kind);
    }
  });

  it.each(REQUIRED_LESSON_GROUPS)(
    "required group %s is present and independently checked",
    (group) => {
      const sample = researchLesson();
      expect(sample).toHaveProperty(group);

      const mutated = clone(sample);
      delete (mutated)[group];

      const result = parseLesson(mutated);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].group).toBe(group);
        expect(
          `${result.failures[0].path} ${result.failures[0].message}`,
        ).toContain(group);
      }
    },
  );
});

describe("kind discrimination", () => {
  it("never validates a change lesson with the research schema", () => {
    expect(LessonSchema.safeParse(changeLesson()).success).toBe(false);
    expect(ChangeLessonSchema.safeParse(changeLesson()).success).toBe(true);
    expect(AnyLessonSchema.safeParse(changeLesson()).success).toBe(true);
  });

  it("never validates a comparison lesson with the research schema", () => {
    expect(LessonSchema.safeParse(comparisonLesson()).success).toBe(false);
    expect(ComparisonLessonSchema.safeParse(comparisonLesson()).success).toBe(
      true,
    );
    expect(AnyLessonSchema.safeParse(comparisonLesson()).success).toBe(true);
  });

  it("maps each kind to the schema that owns it", () => {
    expect(schemaForKind("research")).toBe(LessonSchema);
    expect(schemaForKind("change")).toBe(ChangeLessonSchema);
    expect(schemaForKind("comparison")).toBe(ComparisonLessonSchema);
  });
});

describe("edge cases that must keep passing", () => {
  it("allows empty choices when a reason is supplied", () => {
    const sample = clone(researchLesson());
    sample.choices = [];
    sample.choicesOmittedReason = "没有可比较的替代方案";
    expect(parseLesson(sample).ok).toBe(true);
  });

  it("allows an empty overview and an empty diagram node list", () => {
    const sample = clone(researchLesson());
    sample.overview = [];
    sample.diagram = {
      kind: "component",
      mermaid: "flowchart LR",
      nodes: [],
      edges: [],
    };
    expect(parseLesson(sample).ok).toBe(true);
  });

  it("strips unknown extra keys instead of failing the lesson", () => {
    const sample = clone(researchLesson());
    const withExtra = {
      ...sample,
      unknownTopLevel: "ignored",
      context: { ...(sample.context as Record<string, unknown>), extra: 1 },
    };
    const result = parseLesson(withExtra);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lesson).not.toHaveProperty("unknownTopLevel");
    }
  });

  it("allows a null choicesOmittedReason when choices are present", () => {
    const sample = clone(researchLesson());
    sample.choicesOmittedReason = null;
    expect(parseLesson(sample).ok).toBe(true);
  });
});
