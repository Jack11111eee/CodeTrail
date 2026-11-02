import { describe, expect, it } from "vitest";

import type { SourceId } from "../../../src/learning/contracts/index.ts";
import type { AnyLesson } from "../../../src/learning/lessons/schema.ts";
import {
  lessonToMarkdown,
  parseMarkdownBack,
} from "../../../src/learning/lessons/export.ts";
import { changeFixture, researchFixture } from "../helpers/lesson-context.ts";

function expectedEvidenceIds(lesson: AnyLesson): SourceId[] {
  const ids: string[] = [...lesson.evidence];
  for (const statement of lesson.statements) ids.push(...statement.evidenceIds);
  for (const choice of lesson.choices) {
    ids.push(...choice.evidenceIds);
    for (const alternative of choice.alternatives) {
      ids.push(...alternative.evidenceIds);
    }
  }
  for (const boundary of lesson.boundaries) ids.push(...boundary.evidenceIds);
  for (const node of lesson.diagram.nodes) ids.push(...node.evidenceIds);
  for (const edge of lesson.diagram.edges) ids.push(...edge.evidenceIds);
  if (lesson.kind === "change") {
    for (const alternative of lesson.alternatives) {
      ids.push(...alternative.evidenceIds);
    }
  }
  return [...new Set(ids)].sort() as SourceId[];
}

/**
 * AC-LES-16: Markdown export round-trips both the mechanism-id set and the
 * evidence-id set.
 */
describe("Markdown export", () => {
  it("round-trips the mechanism and evidence sets", () => {
    const { lesson, ref } = researchFixture();
    const withTwoMechanisms = structuredClone(lesson);
    withTwoMechanisms.plainExplanation.push({
      mechanismId: "m2",
      text: "第二步再做一次替换。",
    });
    withTwoMechanisms.technicalExplanation.push({
      mechanismId: "m2",
      terms: [{ zh: "替换", en: "replace" }],
      text: "使用 String.prototype.replace。",
    });

    const markdown = lessonToMarkdown(withTwoMechanisms, [ref]);
    const back = parseMarkdownBack(markdown);

    expect(back.mechanismIds).toEqual(["m1", "m2"]);
    expect(back.evidenceIds).toEqual(expectedEvidenceIds(withTwoMechanisms));
  });

  it("preserves an evidence id even when its ref was not supplied", () => {
    const { lesson } = researchFixture();
    const withForeign = structuredClone(lesson);
    const foreign = "s_exportonly00000" as SourceId;
    withForeign.evidence.push(foreign);

    const markdown = lessonToMarkdown(withForeign, []);
    const back = parseMarkdownBack(markdown);

    expect(back.evidenceIds).toContain(foreign);
    expect(back.evidenceIds).toEqual(expectedEvidenceIds(withForeign));
  });

  it("round-trips a change lesson including alternative evidence", () => {
    const { lesson, ref } = changeFixture();

    const markdown = lessonToMarkdown(lesson, [ref]);
    const back = parseMarkdownBack(markdown);

    expect(back.mechanismIds).toEqual(["m1"]);
    expect(back.evidenceIds).toEqual(expectedEvidenceIds(lesson));
  });
});
