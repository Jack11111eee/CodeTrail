import { describe, expect, it } from "vitest";

import { validateStructural } from "../../../src/learning/lessons/validate/structural.ts";
import { externalRef, researchFixture } from "../helpers/lesson-context.ts";

/**
 * AC-LES-05: the four boundary statuses, `implemented` backed by a repo source
 * and `planned` backed by a design document. Planned-only evidence must be
 * downgraded to `unknown` with a reason.
 */
describe("boundaries", () => {
  it("accepts an implemented boundary backed by a repo source", () => {
    const { lesson, ctx } = researchFixture();

    expect(validateStructural(lesson, ctx).ok).toBe(true);
  });

  it("rejects an implemented boundary with no repository evidence", () => {
    const { lesson, ctx, registry } = researchFixture();
    const broken = structuredClone(lesson);
    broken.boundaries = [
      {
        item: "只处理 ASCII",
        status: "implemented",
        limits: "非 ASCII 会被折叠",
        evidenceIds: ["s_missing0000000000"],
      },
    ];

    const result = validateStructural(broken, ctx);

    expect(registry.get(ctx.generation.generationId, broken.evidence[0])).not.toBe(
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("boundaries");
    expect(result.issues[0]?.message).toContain("repository source");
  });

  it("rejects planned-only evidence for an implemented boundary", () => {
    const { lesson, ctx, registry } = researchFixture();
    const design = externalRef({ title: "Design decision: slugify" });
    registry.add(ctx.generation.generationId, design);

    const broken = structuredClone(lesson);
    broken.boundaries = [
      {
        item: "支持 Unicode",
        status: "implemented",
        limits: "尚未实现",
        evidenceIds: [design.sourceId],
      },
    ];
    broken.evidence = [design.sourceId];

    const result = validateStructural(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("boundaries");
    expect(result.issues[0]?.message).toContain("downgrade");
  });

  it("accepts a planned boundary backed by a design document", () => {
    const { lesson, ctx, registry } = researchFixture();
    const design = externalRef({ title: "RFC: Unicode slugify" });
    registry.add(ctx.generation.generationId, design);

    const valid = structuredClone(lesson);
    valid.boundaries = [
      {
        item: "支持 Unicode",
        status: "planned",
        limits: "需要引入依赖",
        evidenceIds: [design.sourceId],
      },
    ];

    expect(validateStructural(valid, ctx).ok).toBe(true);
  });

  it("rejects a planned boundary with no design document", () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.boundaries = [
      {
        item: "支持 Unicode",
        status: "planned",
        limits: "需要引入依赖",
        evidenceIds: broken.evidence,
      },
    ];

    const result = validateStructural(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("boundaries");
    expect(result.issues[0]?.message).toContain("design-document");
  });
});
