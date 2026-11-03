/**
 * AC-F07-01 — the lesson states the current approach plus a genuinely
 * comparable alternative (fit and cost), or an explicit empty-with-reason, and
 * `boundaries` distinguishes implemented/demo/planned/unknown consistently
 * with its evidence.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  analyzeToCompletion,
  generationScripts,
  importLocal,
  jsonOf,
  sourceIdOf,
  startAcceptance,
  type AcceptanceServer,
} from "./support.ts";

const SOURCE_PATH = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 6, end: 20 };
const DESIGN_PATH = "docs/decisions/decision-log.md";

let server: AcceptanceServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
}, 240_000);

interface LessonDetail {
  lesson: {
    choices: {
      decision: string;
      current: string;
      alternatives: {
        option: string;
        whenItFits: string;
        cost: string;
        evidenceIds: string[];
      }[];
      evidenceIds: string[];
    }[];
    choicesOmittedReason: string | null;
    boundaries: {
      item: string;
      status: "implemented" | "demo" | "planned" | "unknown";
      limits: string;
      evidenceIds: string[];
    }[];
  };
}

async function lessonOf(
  target: AcceptanceServer,
  generationId: string,
): Promise<LessonDetail> {
  const list = jsonOf<{ lessons: { lessonId: string }[] }>(
    await target.request(`/api/generations/${generationId}/lessons`),
    200,
  );
  return jsonOf<LessonDetail>(
    await target.request(
      `/api/generations/${generationId}/lessons/${list.lessons[0].lessonId}`,
    ),
    200,
  );
}

describe("AC-F07-01: choices and boundaries", () => {
  test("an alternative carries fit and cost; boundaries agree with evidence", async () => {
    server = await startAcceptance();
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
      }),
    );
    const project = await importLocal(server);
    const { analysis, job } = await analyzeToCompletion(
      server,
      project.projectId,
    );
    expect(job.state).toBe("completed");

    const detail = await lessonOf(server, analysis.generationId);
    const codeId = sourceIdOf(SOURCE_PATH, server.commitSha, LINES);
    const designId = sourceIdOf(DESIGN_PATH, server.commitSha, null);

    // The current approach is stated, and at least one alternative is genuinely
    // comparable: different option, with a fit and a cost, and its own evidence.
    expect(
      detail.lesson.choices.length +
        (detail.lesson.choicesOmittedReason ? 1 : 0),
    ).toBeGreaterThan(0);
    for (const choice of detail.lesson.choices) {
      expect(choice.current.trim()).not.toBe("");
      expect(choice.decision.trim()).not.toBe("");
      expect(choice.evidenceIds.length).toBeGreaterThan(0);
      expect(choice.decision).not.toBe(choice.current);
      for (const alternative of choice.alternatives) {
        expect(alternative.option.trim()).not.toBe("");
        expect(alternative.option).not.toBe(choice.current);
        expect(alternative.whenItFits.trim()).not.toBe("");
        expect(alternative.cost.trim()).not.toBe("");
        expect(alternative.evidenceIds.length).toBeGreaterThan(0);
      }
    }

    // Boundaries: all four statuses present, and each is consistent with the
    // evidence its citations resolve to.
    const statuses = new Set(detail.lesson.boundaries.map((b) => b.status));
    expect(statuses).toEqual(
      new Set(["implemented", "demo", "planned", "unknown"]),
    );
    for (const boundary of detail.lesson.boundaries) {
      expect(boundary.item.trim()).not.toBe("");
      expect(boundary.limits.trim()).not.toBe("");
      if (boundary.status === "unknown") {
        expect(boundary.evidenceIds).toEqual([]);
        continue;
      }
      expect(boundary.evidenceIds.length).toBeGreaterThan(0);
      for (const sourceId of boundary.evidenceIds) {
        const source = jsonOf<{ commitSha: string; kind: string }>(
          await server.request(
            `/api/generations/${analysis.generationId}/sources/${sourceId}`,
          ),
          200,
        );
        expect(source.commitSha).toBe(server.commitSha);
      }
      if (boundary.status === "implemented") {
        const ids = boundary.evidenceIds;
        expect(ids).toContain(codeId);
        expect(ids).not.toEqual([designId]);
      }
      if (boundary.status === "planned") {
        expect(boundary.evidenceIds).toContain(designId);
      }
    }

    // The empty-with-reason path is also expressible: a lesson that omits
    // choices must carry a reason (the schema refuses one without the other).
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
        lessonPatch: {
          choices: [],
          choicesOmittedReason:
            "该模块没有可比较的实现选择，接口只有一种调用方式。",
        },
      }),
    );
    const alternativeLess = await analyzeToCompletion(
      server,
      project.projectId,
      {
        ref: "main",
        scope: { include: ["src/**", "docs/**"] },
      },
    );
    expect(alternativeLess.job.state).toBe("completed");
    const variant = await lessonOf(
      server,
      alternativeLess.analysis.generationId,
    );
    expect(variant.lesson.choices).toEqual([]);
    expect(variant.lesson.choicesOmittedReason?.trim()).not.toBe("");
  }, 240_000);
});
