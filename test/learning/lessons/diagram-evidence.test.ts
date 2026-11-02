import { describe, expect, it } from "vitest";

import type { SourceId } from "../../../src/learning/contracts/index.ts";
import {
  bindNodeEvidence,
  toRenderData,
} from "../../../src/learning/lessons/diagram.ts";
import { validateDiagram } from "../../../src/learning/lessons/validate/diagram.ts";
import { researchFixture } from "../helpers/lesson-context.ts";

/**
 * AC-LES-10: every node and edge citation belongs to the generation, and the
 * inferred/planned/demo flags survive into the render projection.
 */
describe("diagram evidence", () => {
  it("accepts a diagram whose nodes cite registered sources", async () => {
    const { lesson, ctx } = researchFixture();

    const result = await validateDiagram(lesson, ctx);

    expect(result.ok).toBe(true);
  });

  it("rejects a node whose evidence id is not registered", async () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.diagram.nodes[0].evidenceIds = [
      "s_notregistered00000" as SourceId,
    ];

    const result = await validateDiagram(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("diagram_evidence");
    expect(result.issues[0]?.message).toContain("not registered");
  });

  it("rejects an observed node with no evidence", async () => {
    const { lesson, ctx } = researchFixture();
    const broken = structuredClone(lesson);
    broken.diagram.nodes[0].evidenceIds = [];

    const result = await validateDiagram(broken, ctx);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("diagram_evidence");
    expect(result.issues[0]?.message).toContain("observed node");
  });

  it("binds one node's evidence through bindNodeEvidence", () => {
    const { lesson, ctx } = researchFixture();

    expect(bindNodeEvidence(lesson.diagram.nodes[0], ctx).ok).toBe(true);
  });

  it("exposes inferred edges and planned/demo nodes in toRenderData", () => {
    const { lesson } = researchFixture();
    const withFlags = structuredClone(lesson);
    withFlags.diagram.nodes = [
      {
        id: "n1",
        label: "planned",
        evidenceIds: [],
        status: "planned",
      },
      {
        id: "n2",
        label: "demo",
        evidenceIds: [],
        status: "demo",
      },
    ];
    withFlags.diagram.edges = [
      {
        from: "n1",
        to: "n2",
        label: "可能",
        evidenceIds: [],
        inferred: true,
      },
    ];

    const render = toRenderData(withFlags);

    expect(render.inferredEdgeIds).toEqual(["n1->n2"]);
    expect(render.plannedNodeIds).toEqual(["n1"]);
    expect(render.demoNodeIds).toEqual(["n2"]);
    expect(render.commitSha).toBe(withFlags.context.commitSha);
  });
});
