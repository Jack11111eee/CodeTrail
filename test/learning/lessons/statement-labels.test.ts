import { describe, expect, it } from "vitest";

import { validateLabels } from "../../../src/learning/lessons/validate/labels.ts";
import { validateStructural } from "../../../src/learning/lessons/validate/structural.ts";
import {
  externalRef,
  researchFixture,
  teachingExampleRef,
} from "../helpers/lesson-context.ts";

/**
 * AC-LES-06/14: the label/source matrix, the overclaiming-copy prohibition and
 * the explicit example label.
 */
describe("statement labels", () => {
  it("accepts a code fact backed by a repository source", () => {
    const { lesson, ctx } = researchFixture();

    expect(validateLabels(lesson, ctx).ok).toBe(true);
  });

  it("rejects recorded_design_rationale without a design document", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.statements = [
      {
        id: "st1",
        label: "recorded_design_rationale",
        text: "作者决定使用正则。",
        evidenceIds: broken.evidence,
      },
    ];

    const result = validateLabels(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("labels");
    expect(result.issues[0]?.message).toContain("recorded_design_rationale");
  });

  it("accepts recorded_design_rationale with a design document", () => {
    const { lesson, ctx, registry } = researchFixture();
    const design = externalRef({ title: "ADR-004: use a regex slugifier" });
    registry.add(ctx.generation.generationId, design);

    const valid = structuredClone(lesson);
    valid.statements = [
      {
        id: "st1",
        label: "recorded_design_rationale",
        text: "作者在 ADR 中记录了这个决定。",
        evidenceIds: [design.sourceId],
      },
    ];
    valid.evidence = [design.sourceId];

    expect(validateLabels(valid, ctx).ok).toBe(true);
  });

  it("rejects engineering_analysis that cites only a decision document", () => {
    const { lesson, ctx, registry } = researchFixture();
    const design = externalRef({ title: "Design doc: slugify" });
    registry.add(ctx.generation.generationId, design);

    const broken = structuredClone(lesson);
    broken.statements = [
      {
        id: "st1",
        label: "engineering_analysis",
        text: "作者一定是想让 URL 更短。",
        evidenceIds: [design.sourceId],
      },
    ];
    broken.evidence = [design.sourceId];

    const result = validateLabels(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("labels");
    expect(result.issues[0]?.message).toContain("engineering_analysis");
  });

  it("rejects a teaching_example that cites repository evidence", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.statements = [
      {
        id: "st1",
        label: "teaching_example",
        text: "假设有一个示例函数。",
        evidenceIds: broken.evidence,
      },
    ];

    const result = validateLabels(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("labels");
    expect(result.issues[0]?.message).toContain("teaching_example");
  });

  it("accepts a teaching_example that cites only a teaching example", () => {
    const { lesson, ctx, registry } = researchFixture();
    const example = teachingExampleRef();
    registry.add(ctx.generation.generationId, example);

    const valid = structuredClone(lesson);
    valid.statements = [
      {
        id: "st1",
        label: "teaching_example",
        text: "示例：输入 ` Hello ` 得到 `hello`。",
        evidenceIds: [example.sourceId],
      },
    ];
    valid.evidence = [example.sourceId];

    expect(validateLabels(valid, ctx).ok).toBe(true);
  });

  it("rejects overclaiming copy anywhere in the lesson", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.statements[0].text = "这个实现 proven correct，可以放心使用。";

    const result = validateLabels(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("copy");
  });

  it("requires the scenario to be explicitly labelled as an example", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson) as unknown as Record<string, unknown>;
    const scenario = broken.scenario as Record<string, unknown>;
    scenario.isExample = false;

    const result = validateLabels(broken as never, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("example_label");
  });

  it("change lessons need omission reasons for empty record fields", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson) as unknown as Record<string, unknown>;
    Object.assign(broken, {
      kind: "change",
      eventId: "e_0123456789abcdef",
      omittedReasons: {},
      behaviorChange: { before: "copies", after: "quantity" },
      affectedModules: [],
      keyTechnologies: ["TypeScript"],
      alternatives: [],
      unverifiedEffects: [],
    });

    const result = validateStructural(broken as never, {
      ...ctx,
      mode: "change",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("change_fields");
  });
});
