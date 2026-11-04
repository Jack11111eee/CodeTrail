import { afterEach, describe, expect, it } from "vitest";

import {
  LearningError,
  type CoverageReport,
} from "../../../src/learning/contracts/index.ts";
import {
  assertPublishable,
  buildResearchLessons,
  publishVerdict,
} from "../../../src/learning/lessons/builder.ts";
import { validateStructural } from "../../../src/learning/lessons/validate/structural.ts";
import {
  EMPTY_CLAIMS,
  cleanupScripts,
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

afterEach(cleanupScripts);

function partialCoverage(path: string): CoverageReport {
  const base = emptyCoverage([path]);
  return {
    ...base,
    complete: false,
    gaps: [
      {
        path: "assets/logo.png",
        reason: "excluded_binary",
        bytes: 128,
      },
    ],
    counts: {
      totalFiles: base.counts.totalFiles + 1,
      analyzedFiles: base.counts.analyzedFiles,
      excludedFiles: 1,
    },
  };
}

function inputFor(
  fixture: ReturnType<typeof researchFixture>,
  model: ReturnType<typeof scriptedHandle>,
  coverage: CoverageReport,
) {
  return {
    generation: fixture.ctx.generation,
    snapshot: fakeSnapshot(fixture.files, {
      commitSha: fixture.ctx.generation.commitSha,
      repoId: fixture.ctx.generation.repoId,
    }),
    scope: fixture.ctx.scope,
    coverage,
    model,
    registry: fixture.registry,
    external: stubExternal(),
    clock: fixedClock(),
  };
}

/**
 * AC-LES-13: partial coverage publishes with a non-empty `coverageGaps`;
 * zero publishable lessons fail with `blank_teaching` and publish nothing.
 */
describe("publish gating", () => {
  it("publishes a partial generation and records its coverage gaps", async () => {
    const fixture = researchFixture();
    const dir = scriptDir([lessonEntry(fixture.lesson)]);
    const model = scriptedHandle(dir);

    const result = await buildResearchLessons(
      inputFor(fixture, model, partialCoverage("src/index.ts")),
      { claims: EMPTY_CLAIMS, mermaid: okMermaid() },
    );

    expect(result.failures).toEqual([]);
    expect(result.blankTeaching).toBe(false);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].coverageGaps.length).toBeGreaterThan(0);
    expect(publishVerdict(result)).toEqual({ publishable: true });
  });

  it("drops a lesson with a missing required group and fails blank_teaching", async () => {
    const fixture = researchFixture();
    const broken = structuredClone(fixture.lesson) as unknown as Record<
      string,
      unknown
    >;
    delete broken.statements;

    const dir = scriptDir([lessonEntry(broken)]);
    const model = scriptedHandle(dir);

    const result = await buildResearchLessons(
      inputFor(fixture, model, emptyCoverage(["src/index.ts"])),
      { claims: EMPTY_CLAIMS, mermaid: okMermaid() },
    );

    expect(result.lessons).toEqual([]);
    expect(result.blankTeaching).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(publishVerdict(result)).toEqual({
      publishable: false,
      reason: "blank_teaching",
    });

    let thrown: unknown;
    try {
      assertPublishable(result);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LearningError);
    const failure = thrown as LearningError;
    expect(failure.code).toBe("conflict");
    expect(failure.details?.reason).toBe("blank_teaching");
  });

  it("drops a lesson whose evidence check failed", async () => {
    const fixture = researchFixture();
    const broken = structuredClone(fixture.lesson);
    // An unregistered id on a choice survives the semantic downgrade, so the
    // evidence gate is what must drop the lesson.
    broken.choices[0].evidenceIds = ["s_neverregistered0000" as never];

    const dir = scriptDir([lessonEntry(broken)]);
    const model = scriptedHandle(dir);

    const result = await buildResearchLessons(
      inputFor(fixture, model, emptyCoverage(["src/index.ts"])),
      { claims: EMPTY_CLAIMS, mermaid: okMermaid() },
    );

    expect(result.lessons).toEqual([]);
    expect(result.blankTeaching).toBe(true);
  });

  it("rejects incomplete coverage with no coverageGaps", () => {
    const fixture = researchFixture();
    const result = validateStructural(fixture.lesson, {
      ...fixture.ctx,
      coverage: partialCoverage("src/index.ts"),
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("coverage");
  });

  it("accepts incomplete coverage when coverageGaps is non-empty", () => {
    const fixture = researchFixture();
    const lesson = structuredClone(fixture.lesson);
    lesson.coverageGaps = ["assets/logo.png: excluded_binary"];

    const result = validateStructural(lesson, {
      ...fixture.ctx,
      coverage: partialCoverage("src/index.ts"),
    });

    expect(result.ok).toBe(true);
  });
});
