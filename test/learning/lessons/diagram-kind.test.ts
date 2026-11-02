import { describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  DIAGRAM_KIND_BY_PURPOSE,
  assertDiagramKind,
  diagramPurposeOf,
  parseLesson,
} from "../../../src/learning/lessons/schema.ts";
import { assembleComponentDiagram } from "../../../src/learning/lessons/assemble.ts";
import {
  assembleInput,
  changeLesson,
  clone,
  comparisonLesson,
  emptyCoverage,
  researchLesson,
} from "../helpers/lesson-sample.ts";

function parsed(sample: Record<string, unknown>) {
  const result = parseLesson(sample);
  if (!result.ok) {
    throw new Error(`sample did not parse: ${JSON.stringify(result.failures)}`);
  }
  return result.lesson;
}

/**
 * AC-LES-09: the purpose table is fixed, a kind outside the purpose's list is
 * rejected, and the assembler always emits a component diagram.
 */
describe("purpose → kind mapping", () => {
  it("is the single frozen table", () => {
    expect(DIAGRAM_KIND_BY_PURPOSE).toEqual({
      module_relation: ["component"],
      request_roundtrip: ["sequence"],
      version_change: ["state", "timeline"],
    });
  });

  it.each([
    ["module_relation", "component"],
    ["request_roundtrip", "sequence"],
    ["version_change", "state"],
    ["version_change", "timeline"],
  ] as const)("accepts %s → %s", (purpose, kind) => {
    expect(() => assertDiagramKind(purpose, kind)).not.toThrow();
  });

  it.each([
    ["module_relation", "sequence"],
    ["module_relation", "state"],
    ["module_relation", "timeline"],
    ["request_roundtrip", "component"],
    ["request_roundtrip", "state"],
    ["request_roundtrip", "timeline"],
    ["version_change", "component"],
    ["version_change", "sequence"],
  ] as const)("rejects %s → %s", (purpose, kind) => {
    expect(() => assertDiagramKind(purpose, kind)).toThrow(LearningError);
    try {
      assertDiagramKind(purpose, kind);
    } catch (error) {
      expect((error as LearningError).code).toBe("invalid_input");
      expect((error as LearningError).details).toMatchObject({
        purpose,
        kind,
      });
    }
  });
});

describe("diagramPurposeOf", () => {
  it("treats a change lesson as a version change", () => {
    expect(diagramPurposeOf(parsed(changeLesson()))).toBe("version_change");
  });

  it("treats a comparison lesson as a version change", () => {
    expect(diagramPurposeOf(parsed(comparisonLesson()))).toBe("version_change");
  });

  it("treats a library-interface research lesson as a module relation", () => {
    expect(diagramPurposeOf(parsed(researchLesson()))).toBe("module_relation");
  });

  it.each(["user_flow", "api_call", "cli"] as const)(
    "treats a %s research lesson as a request roundtrip",
    (kind) => {
      const sample = clone(researchLesson());
      (sample.scenario as Record<string, unknown>).kind = kind;
      expect(diagramPurposeOf(parsed(sample))).toBe("request_roundtrip");
    },
  );
});

describe("assembleComponentDiagram", () => {
  it("always emits a component diagram", () => {
    const diagram = assembleComponentDiagram(
      assembleInput({ coverage: emptyCoverage(["src/app.ts", "README.md"]) }),
    );
    expect(diagram.kind).toBe("component");
    expect(diagram.nodes.map((node) => node.label)).toEqual(["src"]);
    expect(diagram.edges).toEqual([]);
    expect(diagram.mermaid).toBe('flowchart LR\n  n1["src"]');
  });

  it("is deterministic for identical input", () => {
    const input = assembleInput({
      coverage: emptyCoverage(["src/a.ts", "test/a.test.ts", "README.md"]),
      pages: ["beta", "alpha"],
    });
    expect(assembleComponentDiagram(input)).toEqual(
      assembleComponentDiagram(input),
    );
  });

  it("uses the page list for modules when pages exist", () => {
    const diagram = assembleComponentDiagram(
      assembleInput({
        coverage: emptyCoverage(["src/a.ts", "src/b.ts"]),
        pages: ["beta", "alpha", "alpha"],
      }),
    );
    expect(diagram.nodes.map((node) => node.label)).toEqual(["alpha", "beta"]);
  });

  it("handles an empty repository without inventing nodes", () => {
    const diagram = assembleComponentDiagram(
      assembleInput({ coverage: emptyCoverage([]) }),
    );
    expect(diagram).toEqual({
      kind: "component",
      mermaid: "flowchart LR",
      nodes: [],
      edges: [],
    });
  });

  it("stays a component diagram for a UI project", () => {
    const diagram = assembleComponentDiagram(
      assembleInput({ coverage: emptyCoverage(["src/App.vue"]) }),
    );
    expect(diagram.kind).toBe("component");
  });
});
