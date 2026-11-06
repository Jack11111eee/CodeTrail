import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newLessonId } from "../../../src/learning/contracts/index.ts";
import type {
  Lesson,
  LessonBuilderPort,
  ProjectId,
  ProjectRecord,
} from "../../../src/learning/contracts/index.ts";
import {
  createHarness,
  generationInput,
  runToCompletion,
  SHA_A,
  SHA_B,
  type Harness,
} from "../generation/harness.ts";
import { countTestId, startUiServer, uiDepsFrom } from "./merge-ui-server.ts";
import type { UiServer } from "./merge-ui-server.ts";

/**
 * Integration: the jobs/publish branch's real runner + publisher write a
 * generation, its `lessons/*.json`, `coverage.json` and source rows, and the
 * ui branch's static seam renders that generation into the reader page.
 *
 * The seam under test lives between two branches:
 *   JobRunner → Publisher (seal/rename/transaction) → SQLite + knowledge dir
 *   → `api/static.ts` (readLessonJson/readCoverage) → `ui/pages/reader.ts`
 *   → `ui/render/diagram.ts`.
 *
 * Only the model, the upstream generator and the snapshot service are doubled
 * (the generation harness's documented seams); the lesson builder below is a
 * test double for the model-driven lesson content, which is exactly where the
 * evidence ids and diagram nodes come from.
 */

const PROJECT_ID = "p_level8_reader" as ProjectId;

function projectRecord(harness: Harness): ProjectRecord {
  return {
    projectId: PROJECT_ID,
    repoId: harness.repoId,
    kind: "local",
    displayName: "codetrail-fixture",
    remoteUrl: null,
    defaultBranch: "main",
    scope: harness.scope,
    watchEnabled: false,
    createdAt: harness.clock.now().toISOString(),
    deletedAt: null,
  };
}

/**
 * A research lesson rich enough for the reader: one component-diagram node
 * bound to a real repo source, one `code_fact` statement, and a boundary.
 * It mirrors `test/learning/helpers/lesson-sample.ts` but binds the ids of the
 * generation actually being published.
 */
function richLesson(
  generation: { generationId: string; repoId: string; commitSha: string },
  sourceId: string,
): Lesson {
  const lessonId = newLessonId(`${generation.generationId}:research`);
  return {
    lessonId,
    generationId: generation.generationId,
    kind: "research",
    context: {
      repoId: generation.repoId,
      commitSha: generation.commitSha,
      generationId: generation.generationId,
      scenarioId: "sc_reader_flow",
      moduleIds: ["src"],
    },
    scenario: {
      id: "sc_reader_flow",
      kind: "library_interface",
      inputs: ["label"],
      userAction: "调用公开接口",
      observableResult: "返回 URL 安全的 slug",
      isExample: true,
    },
    overview: [
      {
        moduleId: "src",
        responsibility: "把标签转换成 URL 安全的 slug",
        inputs: ["label"],
        outputs: ["slug"],
      },
    ],
    plainExplanation: [{ mechanismId: "m1", text: "先去空格，再统一小写。" }],
    technicalExplanation: [
      {
        mechanismId: "m1",
        terms: [{ zh: "slug", en: "slug", symbol: "slugify" }],
        text: "用正则把非字母数字字符折叠成连字符。",
      },
    ],
    choices: [],
    choicesOmittedReason: "样例只演示一个机制，没有可比较的替代方案。",
    boundaries: [
      {
        item: "只处理 ASCII",
        status: "implemented",
        limits: "非 ASCII 字符会被折叠掉",
        evidenceIds: [sourceId],
      },
    ],
    statements: [
      {
        id: "st1",
        label: "code_fact",
        text: "slugify 会先 trim 再小写。",
        evidenceIds: [sourceId],
      },
    ],
    evidence: [sourceId],
    diagram: {
      kind: "component",
      mermaid: 'flowchart LR\n  n1["src/index.ts"]',
      nodes: [
        {
          id: "n1",
          label: "src/index.ts",
          evidenceIds: [sourceId],
          status: "observed",
        },
      ],
      edges: [],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
  } as unknown as Lesson;
}

function builder(options: { failForSha?: string } = {}): LessonBuilderPort {
  return {
    async buildResearchLessons(input) {
      if (input.generation.commitSha === options.failForSha) {
        throw new Error("lesson build failed for this commit");
      }
      const ref = await input.registry.registerRepo({
        generationId: input.generation.generationId,
        repoId: input.generation.repoId,
        commitSha: input.generation.commitSha,
        path: "src/index.ts",
        lines: { start: 1, end: 2 },
        snapshot: input.snapshot,
        scope: input.scope,
      });
      return {
        lessons: [
          richLesson(
            {
              generationId: input.generation.generationId,
              repoId: input.generation.repoId,
              commitSha: input.generation.commitSha,
            },
            ref.sourceId,
          ),
        ],
        failures: [],
        blankTeaching: false,
      };
    },
    buildChangeLesson() {
      return Promise.reject(
        new Error("change lessons are not exercised by this suite"),
      );
    },
    buildComparisonLesson() {
      return Promise.reject(
        new Error("comparison lessons are not exercised by this suite"),
      );
    },
  };
}

function enqueue(
  harness: Harness,
  sha: string,
  options: { mode?: "init" | "update"; streamId?: string } = {},
) {
  return {
    ...generationInput(harness, {
      sha,
      mode: options.mode,
      streamId: options.streamId ?? null,
    }),
    projectId: PROJECT_ID,
  };
}

interface Setup {
  harness: Harness;
  generationId: string;
  sourceId: string;
  lessonId: string;
  knowledgeDir: string;
}

async function publishInitial(harness: Harness): Promise<Setup> {
  harness.repos.projects.insert(projectRecord(harness));
  const job = await runToCompletion(harness, enqueue(harness, SHA_A));
  expect(job.state, "initial generation job must complete").toBe("completed");
  const generationId = job.outputGenerationId;
  expect(generationId, "publisher must record the output generation").not.toBe(
    null,
  );
  const generation = harness.repos.generations.byId(generationId!);
  expect(generation?.status).toBe("published");

  const lessons = harness.repos.lessons.listByGeneration(generationId!);
  expect(lessons, "the published generation must expose one lesson").toHaveLength(
    1,
  );
  const sources = harness.repos.sources.all(generationId!);
  expect(sources.length).toBeGreaterThan(0);

  return {
    harness,
    generationId: generationId!,
    sourceId: sources[0].sourceId,
    lessonId: lessons[0].lessonId,
    knowledgeDir: generation!.contentDir,
  };
}

let harness: Harness | undefined;
let server: UiServer | undefined;
let setup: Setup | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (harness !== undefined) harness.close();
  harness = undefined;
  setup = undefined;
});

describe("published generation rendered by the learning reader", () => {
  beforeEach(async () => {
    harness = await createHarness({
      lessonBuilder: builder({ failForSha: SHA_B }),
    });
    setup = await publishInitial(harness);
    server = await startUiServer(uiDepsFrom(harness));
  });

  it("renders the lesson, its diagram node evidence and the sealed commit", async () => {
    const page = await server!.get(
      `/learn/reader?generation=${setup!.generationId}`,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type") ?? "").toContain("text/html");

    for (const testid of [
      "reader-nav",
      "reader-lesson",
      "reader-qa",
      "lesson-plain",
      "lesson-technical",
      "lesson-choices",
      "lesson-boundaries",
      "lesson-evidence",
      "coverage-gaps",
      "qa-stream",
      "qa-citations",
    ]) {
      expect(countTestId(page.text, testid), `${testid} must render once`).toBe(
        1,
      );
    }

    // The nav title comes from the lesson row the publisher inserted.
    expect(page.text).toContain("sc_reader_flow");

    // The diagram comes from the lesson file through `toRenderData`; its node
    // must carry the *published* generation's commit and evidence id.
    expect(countTestId(page.text, "diagram-component")).toBe(1);
    expect(page.text).toContain(`data-commit-sha="${SHA_A}"`);
    const nodeEvidence = /data-diagram-node="true"[^>]*data-evidence-ids="([^"]*)"/u.exec(
      page.text,
    )?.[1];
    expect(nodeEvidence, "diagram node must bind its evidence").toBeTruthy();
    for (const sourceId of nodeEvidence!.split(",").filter(Boolean)) {
      expect(
        harness!.repos.sources.get(setup!.generationId as never, sourceId as never),
        `diagram evidence ${sourceId} must be a registered source row`,
      ).not.toBeNull();
    }
    // The page's Mermaid source is inert text, never an executable script.
    expect(page.text).not.toMatch(/<script[^>]*>[^<]*flowchart/iu);
  });

  it("serves the lesson file the row points at, byte-identical to its json_sha256", () => {
    const row = harness!.repos.lessons.listByGeneration(
      setup!.generationId as never,
    )[0];
    const lessonFile = path.join(
      setup!.knowledgeDir,
      "lessons",
      `${setup!.lessonId}.json`,
    );
    const body = readFileSync(lessonFile);
    const digest = createHash("sha256").update(body).digest("hex");
    expect(digest, "lesson row hash must match the sealed file").toBe(
      row.jsonSha256,
    );
    const parsed = JSON.parse(body.toString("utf8")) as {
      diagram: { nodes: { evidenceIds: string[] }[] };
    };
    expect(parsed.diagram.nodes[0].evidenceIds).toEqual([setup!.sourceId]);

    // The reader path is the only reader source: the DB row's relPath resolves
    // inside the published content dir, not a staging directory.
    expect(row.relPath).toBe(`lessons/${setup!.lessonId}.json`);
    expect(setup!.knowledgeDir.startsWith(harness!.paths.knowledge)).toBe(true);
    expect(setup!.knowledgeDir.includes(`${path.sep}staging${path.sep}`)).toBe(
      false,
    );
  });

  it("marks the coverage panel complete only because the report has no gaps", async () => {
    const page = await server!.get(`/learn/reader?generation=${setup!.generationId}`);
    expect(page.text).toContain('data-complete="true"');
    expect(page.text).not.toContain("绝不声称完整");
  });

  it("keeps the reader on the published version after a failed update", async () => {
    const failed = await runToCompletion(
      harness!,
      enqueue(harness!, SHA_B, { mode: "update" }),
    );
    expect(failed.state, "a lesson-build failure must fail the job").toBe(
      "failed",
    );

    const page = await server!.get(`/learn/reader?project=${PROJECT_ID}`);
    expect(page.status).toBe(200);
    // The old generation and its lesson are still what the reader serves.
    expect(page.text).toContain(SHA_A.slice(0, 12));
    expect(page.text).not.toContain(SHA_B.slice(0, 12));
    expect(page.text).toContain("sc_reader_flow");

    const latest = harness!.repos.generations.latestPublished(harness!.repoId, {
      kind: "research",
    });
    expect(latest?.generationId).toBe(setup!.generationId);
    expect(latest?.commitSha).toBe(SHA_A);
  });

  it("leaves the reader on the same generation for a cache-hit job", async () => {
    const publishedBefore = readdirSync(harness!.paths.knowledge).sort();
    const callsBefore = harness!.calls.count;

    // A different stream id changes the dedupe key but not the cache key, so
    // this is a genuine cache hit rather than the same job returned again.
    const cached = await runToCompletion(
      harness!,
      enqueue(harness!, SHA_A, { streamId: "reader-cache-hit" }),
    );
    expect(cached.state).toBe("completed");
    expect(cached.outputGenerationId).toBe(setup!.generationId);
    expect(harness!.calls.count, "a cache hit must not call the model").toBe(
      callsBefore,
    );
    expect(readdirSync(harness!.paths.knowledge).sort()).toEqual(
      publishedBefore,
    );

    const page = await server!.get(`/learn/reader?generation=${setup!.generationId}`);
    expect(page.text).toContain("sc_reader_flow");
  });

  it("keeps the published knowledge tree readable after gc", async () => {
    const report = await harness!.publisher.gc();
    expect(report.keptPublished).toBeGreaterThanOrEqual(1);
    expect(report.removedKnowledge).toEqual([]);
    expect(report.removedWorkspaces, "staging is reclaimed").not.toContain(
      setup!.knowledgeDir,
    );

    const page = await server!.get(`/learn/reader?generation=${setup!.generationId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("sc_reader_flow");
    expect(countTestId(page.text, "lesson-plain")).toBe(1);
  });
});
