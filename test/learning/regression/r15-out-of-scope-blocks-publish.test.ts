/**
 * AC-R15-02: an out-of-scope or non-existent source blocks publication of the
 * lesson that cites it. The lesson is dropped, `blankTeaching` is explicit and
 * nothing is published; when valid content remains, it publishes and lists the
 * unreadable source as a coverage gap.
 *
 * The real research builder is driven with a scripted model, so the citations
 * are staged (or rejected) by the production registry and validator.
 */
import { afterEach, describe, expect, it } from "vitest";

import type {
  CoverageReport,
  GenerationId,
  JobId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import {
  LearningError,
  stagedRef,
} from "../../../src/learning/contracts/index.ts";
import { createSourceRegistry } from "../../../src/learning/evidence/registry.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import {
  assertPublishable,
  buildResearchLessons,
  publishVerdict,
} from "../../../src/learning/lessons/builder.ts";
import {
  languageOf,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import {
  cleanupScripts,
  fixedClock,
  fakeSnapshot,
  lessonEntry,
  okMermaid,
  scriptDir,
  scriptedHandle,
  stubExternal,
} from "../helpers/lesson-context.ts";
import { researchLesson } from "../helpers/lesson-sample.ts";

const GENERATION = "g_r15_publish00000" as GenerationId;
const REPO = "r_r15_publish00000" as RepoId;
const JOB = "j_r15_publish00000" as JobId;
const COMMIT = "a".repeat(40);
const INDEX_TEXT = "export const value = 1;\n";
const MISSING = "../secret.ts";
const SAMPLE_ID = "s_0123456789abcdef";

afterEach(() => {
  cleanupScripts();
});

function generation() {
  return stagedRef({
    generationId: GENERATION,
    repoId: REPO,
    commitSha: COMMIT,
    knowledgeDir: "/tmp/r15-publish-knowledge",
    jobId: JOB,
    baseContextSha: null,
  });
}

function coverage(analyzed: string[], gaps: string[]): CoverageReport {
  return {
    generationId: GENERATION,
    commitSha: COMMIT,
    complete: gaps.length === 0,
    analyzed: analyzed.map((path) => ({
      path,
      bytes: Buffer.byteLength(INDEX_TEXT, "utf8"),
      language: languageOf(path),
    })),
    gaps: gaps.map((path) => ({
      path,
      reason: "excluded_by_scope",
      bytes: 0,
    })),
    counts: {
      totalFiles: analyzed.length + gaps.length,
      analyzedFiles: analyzed.length,
      excludedFiles: gaps.length,
    },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

function registry() {
  return createSourceRegistry({
    clock: fixedClock(),
    sources: {
      get: () => null,
      all: () => [],
    } as never,
    generations: {
      byId: () => null,
    } as never,
  });
}

function lessonCiting(sourceId: string): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(researchLesson()).replaceAll(SAMPLE_ID, sourceId),
  ) as Record<string, unknown>;
}

function claimsPort(resources: string[]) {
  return {
    pages: () => Promise.resolve(["index"]),
    claimsFor: () =>
      Promise.resolve([
        {
          id: "c1",
          statement: "the value is exported",
          evidence: resources.map((resource) => ({
            resource,
            version: COMMIT,
          })),
        },
      ]),
    markdown: () => Promise.resolve(""),
  };
}

function buildInput(
  sourceId: string,
  resources: string[],
  gaps: string[],
  analyzed: string[],
) {
  const sources = registry();
  const dir = scriptDir([lessonEntry(lessonCiting(sourceId))]);
  return {
    sources,
    run: () =>
      buildResearchLessons(
        {
          generation: generation(),
          snapshot: fakeSnapshot(
            { "src/index.ts": INDEX_TEXT },
            { commitSha: COMMIT, repoId: REPO },
          ),
          scope: normalizeScope(),
          coverage: coverage(analyzed, gaps),
          model: scriptedHandle(dir),
          registry: sources,
          external: stubExternal(),
          clock: fixedClock(),
        },
        { claims: claimsPort(resources), mermaid: okMermaid() },
      ),
  };
}

describe("AC-R15-02 — out-of-scope sources block publish", () => {
  it("drops a lesson whose only source is out of scope and publishes nothing", async () => {
    const invalidId = repoSourceId(MISSING, COMMIT, null);
    const { sources, run } = buildInput(
      invalidId,
      [`repo://${MISSING}`],
      [MISSING],
      [],
    );

    const result = await run();
    expect(result.lessons).toHaveLength(0);
    expect(result.blankTeaching).toBe(true);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(publishVerdict(result)).toEqual({
      publishable: false,
      reason: "blank_teaching",
    });
    let failure: unknown;
    try {
      assertPublishable(result);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LearningError);
    expect((failure as LearningError).code).toBe("conflict");
    expect((failure as LearningError).details?.reason).toBe("blank_teaching");
    // The out-of-scope path was recorded as a gap, never staged as a source:
    // with no staged refs the generation is still unpublished.
    expect(
      sources
        .gaps(GENERATION)
        .some(
          (gap) => gap.subject === MISSING && gap.status === "source_missing",
        ),
    ).toBe(true);
    expect(() => sources.all(GENERATION)).toThrow(LearningError);
    expect(() => sources.get(GENERATION, invalidId)).toThrow(LearningError);
  });

  it("publishes the valid content and lists the unreadable source as a gap", async () => {
    const validId = repoSourceId("src/index.ts", COMMIT, null);
    const { sources, run } = buildInput(
      validId,
      ["repo://src/index.ts", `repo://${MISSING}`],
      [MISSING],
      ["src/index.ts"],
    );

    const result = await run();
    expect(result.blankTeaching).toBe(false);
    expect(result.lessons).toHaveLength(1);
    expect(publishVerdict(result)).toEqual({ publishable: true });
    expect(() => assertPublishable(result)).not.toThrow();
    expect(result.lessons[0]?.coverageGaps).toEqual(
      expect.arrayContaining([expect.stringContaining(MISSING)]),
    );
    expect(sources.all(GENERATION).map((ref) => ref.sourceId)).toEqual([
      validId,
    ]);
    expect(
      sources
        .gaps(GENERATION)
        .some(
          (gap) => gap.subject === MISSING && gap.status === "source_missing",
        ),
    ).toBe(true);
  });
});
