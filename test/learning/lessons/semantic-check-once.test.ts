import { describe, expect, it } from "vitest";

import type { SemanticRepairFn } from "../../../src/learning/contracts/index.ts";
import { buildResearchLessons } from "../../../src/learning/lessons/builder.ts";
import { validateSemantic } from "../../../src/learning/lessons/validate/semantic.ts";
import {
  EMPTY_CLAIMS,
  fakeSnapshot,
  fixedClock,
  lessonEntry,
  okMermaid,
  researchFixture,
  scriptedHandle,
  scriptDir,
  stubExternal,
} from "../helpers/lesson-context.ts";
import { emptyCoverage } from "../helpers/lesson-sample.ts";

/**
 * AC-LES-17: at most one targeted repair; afterwards the conclusion is
 * deleted, downgraded or relabelled as explicit speculation. The model is
 * never called for a second repair.
 */
describe("semantic validation", () => {
  it("passes without repairing when every statement is supported", async () => {
    const { lesson, ctx } = researchFixture();
    let repairs = 0;
    const repair: SemanticRepairFn = ({ lesson: current }) => {
      repairs += 1;
      return Promise.resolve(current);
    };

    const outcome = await validateSemantic(lesson, ctx, repair);

    expect(outcome.result.ok).toBe(true);
    expect(repairs).toBe(0);
  });

  it("repairs once, then deletes an unsupported code_fact and speculates the analysis", async () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.statements = [
      {
        id: "st1",
        label: "code_fact",
        text: "这个函数永远不会失败。",
        evidenceIds: [],
      },
      {
        id: "st2",
        label: "engineering_analysis",
        text: "作者可能想减少分配。",
        evidenceIds: [],
      },
      {
        id: "st3",
        label: "recorded_design_rationale",
        text: "作者记录了这个决定。",
        evidenceIds: [],
      },
    ];

    let repairs = 0;
    const repair: SemanticRepairFn = ({ lesson: current }) => {
      repairs += 1;
      return Promise.resolve(current);
    };

    const outcome = await validateSemantic(broken, ctx, repair);

    expect(repairs).toBe(1);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.lesson.statements.map((entry) => entry.label)).toEqual([
      "engineering_analysis",
      "engineering_analysis",
    ]);
    expect(outcome.lesson.statements.every((entry) => entry.text.startsWith("推测："))).toBe(
      true,
    );
  });

  it("never calls the model more than initial plus two in the builder", async () => {
    const { lesson, ctx, registry, files } = researchFixture();
    const broken = structuredClone(lesson);
    broken.statements = [
      {
        id: "st1",
        label: "code_fact",
        text: "这个函数永远不会失败。",
        evidenceIds: [],
      },
    ];

    const dir = scriptDir([
      lessonEntry(broken, 1),
      lessonEntry(broken, 2),
      lessonEntry(broken, 3),
    ]);
    const calls: unknown[] = [];
    const model = scriptedHandle(dir, "lesson", (info) => calls.push(info));

    const result = await buildResearchLessons(
      {
        generation: ctx.generation,
        snapshot: fakeSnapshot(files, {
          commitSha: ctx.generation.commitSha,
          repoId: ctx.generation.repoId,
        }),
        scope: ctx.scope,
        coverage: emptyCoverage(["src/index.ts"]),
        model,
        registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { claims: EMPTY_CLAIMS, mermaid: okMermaid() },
    );

    expect(result.lessons).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls).toHaveLength(2);
  });
});
