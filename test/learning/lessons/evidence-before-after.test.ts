import { describe, expect, it } from "vitest";

import type { SourceId } from "../../../src/learning/contracts/index.ts";
import { validateEvidence } from "../../../src/learning/lessons/validate/evidence.ts";
import type { AnyLesson } from "../../../src/learning/lessons/schema.ts";
import {
  comparisonFixture,
  externalRef,
  repoRef,
} from "../helpers/lesson-context.ts";
import { OTHER_HEAD_SHA } from "../helpers/lesson-sample.ts";

function remap(
  lesson: AnyLesson,
  from: SourceId,
  to: SourceId,
): AnyLesson {
  return JSON.parse(
    JSON.stringify(lesson).replaceAll(from, to),
  ) as AnyLesson;
}

/**
 * AC-LES-08: comparison sides are independently versioned. Before and after
 * use different commits, and a statement may only cite its own side.
 */
describe("comparison evidence", () => {
  it("accepts a comparison with distinct base and head sources", async () => {
    const { lesson, ctx } = comparisonFixture();

    const result = await validateEvidence(lesson, ctx);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects equal base and head commit SHAs", async () => {
    const { lesson, ctx } = comparisonFixture();
    const broken = structuredClone(lesson);
    if (broken.kind !== "comparison") throw new Error("fixture kind");
    broken.context.comparison.head.commitSha =
      broken.context.comparison.base.commitSha;

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("evidence_compare");
    expect(result.issues[0]?.message).toContain("different commits");
  });

  it("rejects a base statement that cites a head-side source", async () => {
    const { lesson, ctx, headRef } = comparisonFixture();
    const broken = structuredClone(lesson);
    broken.statements[1].evidenceIds = [headRef.sourceId];

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "evidence_compare",
    );
    expect(
      result.issues.some((entry) => entry.message.includes("base statement")),
    ).toBe(true);
  });

  it("rejects a source from a foreign commit", async () => {
    const { lesson, ctx, registry, headRef } = comparisonFixture();
    const foreign = repoRef({
      path: "src/index.ts",
      text: "export const slugify = 1;",
      lines: { start: 1, end: 1 },
      commitSha: OTHER_HEAD_SHA,
      generationId: ctx.generation.generationId,
    });
    registry.add(ctx.generation.generationId, foreign);
    const broken = remap(lesson, headRef.sourceId, foreign.sourceId);

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "evidence_compare",
    );
  });

  it("rejects an unversioned external source", async () => {
    const { lesson, ctx, registry } = comparisonFixture();
    const unversioned = externalRef({
      title: "Unversioned design note",
      url: "https://example.test/unversioned",
      version: "",
    });
    registry.add(ctx.generation.generationId, unversioned);

    const broken = structuredClone(lesson);
    broken.statements.push({
      id: "st3",
      label: "engineering_analysis",
      text: "外部资料说明了旧行为。",
      evidenceIds: [unversioned.sourceId],
      side: "head",
    });

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "evidence_compare",
    );
    expect(
      result.issues.some((entry) =>
        entry.message.includes("version or retrieval time"),
      ),
    ).toBe(true);
  });
});
