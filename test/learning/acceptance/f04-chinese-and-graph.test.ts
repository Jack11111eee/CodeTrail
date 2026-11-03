/**
 * AC-F04-01 — lesson prose is Chinese with zh/en term pairs, and every diagram
 * source is bound to the generation's own commit.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  analyzeToCompletion,
  generationScripts,
  hasChinese,
  importLocal,
  jsonOf,
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
});

interface LessonDetail {
  lesson: {
    context: { commitSha: string };
    plainExplanation: { text: string }[];
    technicalExplanation: {
      terms: { zh: string; en: string; symbol?: string }[];
      text: string;
    }[];
    statements: { text: string }[];
    evidence: string[];
  };
  diagram: {
    commitSha: string;
    nodes: { evidenceIds: string[] }[];
    edges: { evidenceIds: string[] }[];
  };
}

describe("AC-F04-01: Chinese prose and commit-bound diagram sources", () => {
  test("prose is Chinese, terms are bilingual and diagram sources are versioned", async () => {
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

    const list = jsonOf<{ lessons: { lessonId: string }[] }>(
      await server.request(`/api/generations/${analysis.generationId}/lessons`),
      200,
    );
    const detail = jsonOf<LessonDetail>(
      await server.request(
        `/api/generations/${analysis.generationId}/lessons/${list.lessons[0].lessonId}`,
      ),
      200,
    );

    // Chinese body text in both explanation layers and in the statements.
    expect(detail.lesson.plainExplanation.length).toBeGreaterThan(0);
    for (const entry of detail.lesson.plainExplanation) {
      expect(hasChinese(entry.text)).toBe(true);
    }
    expect(detail.lesson.technicalExplanation.length).toBeGreaterThan(0);
    for (const entry of detail.lesson.technicalExplanation) {
      expect(hasChinese(entry.text)).toBe(true);
      expect(entry.terms.length).toBeGreaterThan(0);
      for (const term of entry.terms) {
        expect(term.zh.trim()).not.toBe("");
        expect(term.en.trim()).not.toBe("");
        expect(hasChinese(term.zh)).toBe(true);
      }
    }
    expect(detail.lesson.statements.length).toBeGreaterThan(0);
    for (const statement of detail.lesson.statements) {
      expect(hasChinese(statement.text)).toBe(true);
    }

    // Every diagram source belongs to the generation's commit: the render data
    // names that commit and each cited source resolves at it.
    expect(detail.diagram.commitSha).toBe(server.commitSha);
    expect(detail.lesson.context.commitSha).toBe(server.commitSha);
    const allNodeSources = detail.diagram.nodes.flatMap(
      (node) => node.evidenceIds,
    );
    expect(allNodeSources.length).toBeGreaterThan(0);
    for (const sourceId of allNodeSources) {
      const source = jsonOf<{ commitSha: string }>(
        await server.request(
          `/api/generations/${analysis.generationId}/sources/${sourceId}`,
        ),
        200,
      );
      expect(source.commitSha).toBe(server.commitSha);
    }

    // The declared evidence set is also generation-bound, not a foreign commit.
    for (const sourceId of detail.lesson.evidence) {
      const source = jsonOf<{ commitSha: string }>(
        await server.request(
          `/api/generations/${analysis.generationId}/sources/${sourceId}`,
        ),
        200,
      );
      expect(source.commitSha).toBe(server.commitSha);
    }
  }, 120_000);
});
