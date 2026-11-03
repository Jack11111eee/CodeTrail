import { describe, expect, it } from "vitest";

import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { validateStructural } from "../../../src/learning/lessons/validate/structural.ts";
import { changeFixture } from "../helpers/lesson-context.ts";
import { changeLesson } from "../helpers/lesson-sample.ts";

/**
 * AC-UPD-27: every change lesson carries all six record fields; an empty array
 * needs an omission reason, and a missing field blocks publication.
 */
const FIELDS = [
  "behaviorChange",
  "affectedModules",
  "keyTechnologies",
  "alternatives",
  "evidence",
  "unverifiedEffects",
] as const;

describe("change record fields", () => {
  it("accepts the canonical six-field change lesson", () => {
    const parsed = parseLesson(changeLesson());
    expect(parsed.ok).toBe(true);
  });

  it("blocks publication when a required field is missing", () => {
    for (const field of FIELDS) {
      const broken = structuredClone(changeLesson());
      delete broken[field];
      const parsed = parseLesson(broken);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.failures.map((failure) => failure.path)).toContain(field);
      }
    }
  });

  it("requires an omission reason for an empty array", () => {
    const fixture = changeFixture();
    const withoutReason = structuredClone(fixture.lesson) as Record<
      string,
      unknown
    >;
    withoutReason.unverifiedEffects = [];
    withoutReason.omittedReasons = {};

    const rejected = validateStructural(withoutReason as never, fixture.ctx);
    expect(rejected.ok).toBe(false);
    expect(
      rejected.issues.some(
        (issue) =>
          issue.code === "change_fields" && issue.path === "unverifiedEffects",
      ),
    ).toBe(true);

    const withReason = structuredClone(withoutReason);
    withReason.omittedReasons = { unverifiedEffects: "没有观察到未验证的影响" };
    const accepted = validateStructural(withReason as never, fixture.ctx);
    expect(accepted.ok).toBe(true);
  });
});
