/**
 * AC-F02-01 — the first screen shows one concrete scenario, module
 * responsibilities with inputs/outputs, and a component diagram whose nodes
 * are clickable and evidence-bound.
 *
 * The fixture has no UI surface, so the scenario must be the library-interface
 * flow rather than an invented user flow.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  analyzeToCompletion,
  generationScripts,
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
}, 240_000);

interface LessonDetail {
  lesson: {
    scenario: {
      kind: string;
      userAction: string;
      observableResult: string;
      isExample: boolean;
    };
    overview: {
      moduleId: string;
      responsibility: string;
      inputs: string[];
      outputs: string[];
    }[];
    evidence: string[];
  };
  diagram: {
    kind: string;
    commitSha: string;
    nodes: { id: string; label: string; evidenceIds: string[] }[];
  };
  html: string;
}

describe("AC-F02-01: scenario, modules and the component diagram", () => {
  test("the lesson opens on one concrete flow with evidence-bound modules", async () => {
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

    const lessonList = jsonOf<{ lessons: { lessonId: string }[] }>(
      await server.request(`/api/generations/${analysis.generationId}/lessons`),
      200,
    );
    const detail = jsonOf<LessonDetail>(
      await server.request(
        `/api/generations/${analysis.generationId}/lessons/${lessonList.lessons[0].lessonId}`,
      ),
      200,
    );

    // A concrete scenario, never an invented UI flow for this non-UI fixture.
    expect(detail.lesson.scenario.kind).not.toBe("user_flow");
    expect(["library_interface", "api_call", "cli"]).toContain(
      detail.lesson.scenario.kind,
    );
    expect(detail.lesson.scenario.userAction.trim()).not.toBe("");
    expect(detail.lesson.scenario.observableResult.trim()).not.toBe("");
    expect(detail.lesson.scenario.isExample).toBe(true);

    // Module responsibilities carry both sides of the interface.
    expect(detail.lesson.overview.length).toBeGreaterThan(0);
    for (const module of detail.lesson.overview) {
      expect(module.moduleId).not.toBe("");
      expect(module.responsibility).not.toBe("");
      expect(Array.isArray(module.inputs)).toBe(true);
      expect(Array.isArray(module.outputs)).toBe(true);
      expect(module.inputs.length + module.outputs.length).toBeGreaterThan(0);
    }

    // A component diagram with clickable nodes: every node names the evidence
    // ids and the commit a click must submit.
    expect(detail.diagram.kind).toBe("component");
    expect(detail.diagram.commitSha).toBe(server.commitSha);
    expect(detail.diagram.nodes.length).toBeGreaterThan(0);
    for (const node of detail.diagram.nodes) {
      expect(node.id).not.toBe("");
      expect(node.evidenceIds.length).toBeGreaterThan(0);
      const source = jsonOf<{ sourceId: string; commitSha: string }>(
        await server.request(
          `/api/generations/${analysis.generationId}/sources/${node.evidenceIds[0]}`,
        ),
        200,
      );
      expect(source.sourceId).toBe(node.evidenceIds[0]);
      expect(source.commitSha).toBe(server.commitSha);
    }

    // The rendered lesson keeps the diagram body the reader makes clickable.
    expect(detail.html).toContain("flowchart");
    expect(detail.html).toContain("snapshot_cache.py");
  }, 240_000);
});
