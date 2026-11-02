import { describe, expect, it } from "vitest";

import {
  assembleComponentDiagram,
  assembleContext,
  assembleOverview,
  assembleScenarioCandidates,
  isUiProject,
  scenarioKindFor,
  type AssembleInput,
} from "../../../src/learning/lessons/assemble.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { reportForFixture } from "../projects/scope-fixtures.ts";
import {
  assembleInput,
  clone,
  defaultGeneration,
  researchLesson,
} from "../helpers/lesson-sample.ts";

function file(
  path: string,
  extra: Record<string, unknown> = {},
): { path: string } {
  return { path, ...extra };
}

async function inputForFixture(name: string): Promise<AssembleInput> {
  const { report, sha } = await reportForFixture(name, normalizeScope());
  return assembleInput({
    generation: defaultGeneration({ commitSha: sha }),
    coverage: report,
    pages: [],
  });
}

/**
 * AC-LES-12: a project without a UI surface never gets a `user_flow`
 * scenario, and the gate rejects one when it is supplied anyway.
 */
describe("isUiProject", () => {
  it.each([
    ["src/App.vue", true],
    ["src/App.tsx", true],
    ["src/App.jsx", true],
    ["public/index.html", true],
    ["vite.config.ts", true],
    ["bin/cli.js", true],
    ["src/index.ts", false],
    ["README.md", false],
  ] as const)("%s ⇒ %s", (path, expected) => {
    expect(isUiProject([file(path)])).toBe(expected);
  });

  it("recognises a UI framework in package.json dependencies", () => {
    const packageJson = file("package.json", {
      content: JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    });
    expect(isUiProject([packageJson])).toBe(true);
  });

  it("recognises a CLI bin entry in package.json", () => {
    const packageJson = file("package.json", {
      content: JSON.stringify({ bin: { tool: "./dist/cli.js" } }),
    });
    expect(isUiProject([packageJson])).toBe(true);
  });

  it("is false for a package.json with neither UI deps nor a bin", () => {
    const packageJson = file("package.json", {
      content: JSON.stringify({ name: "library-noui", main: "src/index.ts" }),
    });
    expect(isUiProject([packageJson])).toBe(false);
  });
});

describe("library-noui", () => {
  it("has no UI surface and no user_flow candidate", async () => {
    const input = await inputForFixture("library-noui");

    expect(isUiProject(input.coverage.analyzed)).toBe(false);
    expect(["api_call", "cli", "library_interface"]).toContain(
      scenarioKindFor(input),
    );

    const candidates = assembleScenarioCandidates(input);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((candidate) => candidate.kind)).not.toContain(
      "user_flow",
    );
  });

  it("assembles the full deterministic skeleton without touching the snapshot", async () => {
    const input = await inputForFixture("library-noui");

    const first = {
      context: assembleContext(input),
      overview: assembleOverview(input),
      scenarios: assembleScenarioCandidates(input),
      diagram: assembleComponentDiagram(input),
    };
    const second = {
      context: assembleContext(input),
      overview: assembleOverview(input),
      scenarios: assembleScenarioCandidates(input),
      diagram: assembleComponentDiagram(input),
    };

    expect(second).toEqual(first);
    expect(first.diagram.kind).toBe("component");
    expect(first.context.commitSha).toBe(input.generation.commitSha);
    // The helper's snapshot rejects every read; reaching it would throw.
    expect(first.overview.length).toBeGreaterThan(0);
  });

  it("rejects a user_flow lesson for the non-UI project", () => {
    const sample = clone(researchLesson());
    (sample.scenario as Record<string, unknown>).kind = "user_flow";

    const result = parseLesson(sample, { isUiProject: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toEqual([
        expect.objectContaining({
          group: "scenario",
          path: "scenario.kind",
        }),
      ]);
    }
  });
});

describe("a UI fixture", () => {
  it("offers a user_flow candidate and still assembles deterministically", async () => {
    const input = await inputForFixture("polyglot");

    expect(isUiProject(input.coverage.analyzed)).toBe(true);
    expect(scenarioKindFor(input)).toBe("user_flow");
    expect(
      assembleScenarioCandidates(input).map((candidate) => candidate.kind),
    ).toContain("user_flow");

    expect(assembleContext(input)).toEqual(assembleContext(input));
    expect(assembleOverview(input)).toEqual(assembleOverview(input));
    expect(assembleComponentDiagram(input)).toEqual(
      assembleComponentDiagram(input),
    );
    expect(assembleComponentDiagram(input).kind).toBe("component");
  });
});
