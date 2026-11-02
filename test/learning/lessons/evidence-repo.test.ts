import { describe, expect, it } from "vitest";

import type { SourceId } from "../../../src/learning/contracts/index.ts";
import { validateEvidence } from "../../../src/learning/lessons/validate/evidence.ts";
import type { AnyLesson } from "../../../src/learning/lessons/schema.ts";
import { repoRef, researchFixture } from "../helpers/lesson-context.ts";

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
 * AC-LES-07: every repo source is re-validated against the snapshot — the path
 * exists, the line range is legal and `content_hash` matches the exact slice.
 */
describe("repository evidence", () => {
  it("accepts a source whose path, range and hash all match", async () => {
    const { lesson, ctx } = researchFixture();

    const result = await validateEvidence(lesson, ctx);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a path that does not exist at the commit", async () => {
    const { lesson, ctx, registry, ref } = researchFixture();
    const missing = repoRef({
      path: "src/missing.ts",
      text: "export const nope = 1;",
      lines: null,
      generationId: ctx.generation.generationId,
    });
    registry.add(ctx.generation.generationId, missing);
    const broken = remap(lesson, ref.sourceId, missing.sourceId);

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("evidence_repo");
    expect(result.issues[0]?.message).toContain("does not exist");
  });

  it("rejects a line range past the end of the file", async () => {
    const { lesson, ctx, registry, ref } = researchFixture();
    const outOfRange = repoRef({
      path: "src/index.ts",
      text: "export const slugify = 1;",
      lines: { start: 1, end: 99 },
      generationId: ctx.generation.generationId,
    });
    registry.add(ctx.generation.generationId, outOfRange);
    const broken = remap(lesson, ref.sourceId, outOfRange.sourceId);

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("evidence_repo");
    expect(result.issues[0]?.message).toContain("line range");
  });

  it("rejects a content hash that does not match the slice", async () => {
    const { lesson, ctx, registry, ref } = researchFixture();
    const drifted = repoRef({
      path: "src/index.ts",
      text: "export function slugify(value: string): string {\n  return value.trim().toLowerCase();\n}",
      lines: { start: 1, end: 2 },
      generationId: ctx.generation.generationId,
      contentHash: "sha256:deadbeef",
    });
    registry.add(ctx.generation.generationId, drifted);
    const broken = remap(lesson, ref.sourceId, drifted.sourceId);

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("evidence_repo");
    expect(result.issues[0]?.message).toContain("content_hash");
  });

  it("rejects an evidence id that was never registered", async () => {
    const { lesson, ctx, ref } = researchFixture();
    const broken = remap(
      lesson,
      ref.sourceId,
      "s_neverregistered0000" as SourceId,
    );

    const result = await validateEvidence(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("evidence_repo");
    expect(result.issues[0]?.message).toContain("not registered");
  });
});
