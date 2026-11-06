import { describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import type { UpstreamMermaidPort } from "../../../src/learning/upstream/mermaid.ts";
import { createUpstreamMermaidPort } from "../../../src/learning/upstream/mermaid.ts";
import {
  assembleComponentDiagram,
  assembleContext,
  assembleOverview,
  assembleScenarioCandidates,
  scenarioKindFor,
} from "../../../src/learning/lessons/assemble.ts";
import {
  assertDiagramKind,
  diagramPurposeOf,
  parseLesson,
} from "../../../src/learning/lessons/schema.ts";
import type { AnyLesson } from "../../../src/learning/lessons/schema.ts";
import {
  assembleInput,
  changeLesson,
  emptyCoverage,
  researchLesson,
} from "../helpers/lesson-sample.ts";

/**
 * Integration: deterministic lesson skeleton (issue-15) + upstream mermaid port
 * (issue-13).
 *
 * The assembler produces the diagram and the ids, the schema checks the lesson
 * shape, the purpose table decides whether a diagram kind fits, and the
 * upstream port is the only thing that can say whether the mermaid body parses.
 * A publish gate needs all four; each module alone would accept a lesson the
 * product must refuse.
 */

interface GateResult {
  ok: boolean;
  stage?: "structural" | "mermaid" | "purpose";
  message?: string;
}

async function publishGate(
  raw: unknown,
  port: UpstreamMermaidPort,
): Promise<GateResult> {
  const parsed = parseLesson(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      stage: "structural",
      message: parsed.failures.map((failure) => failure.message).join("; "),
    };
  }
  const lesson: AnyLesson = parsed.lesson;
  const mermaid = await port.validate(lesson.diagram.mermaid);
  if (!mermaid.ok) {
    return { ok: false, stage: "mermaid", message: mermaid.message };
  }
  try {
    assertDiagramKind(diagramPurposeOf(lesson), lesson.diagram.kind);
  } catch (error) {
    return {
      ok: false,
      stage: "purpose",
      message: error instanceof LearningError ? error.message : String(error),
    };
  }
  return { ok: true };
}

/** A valid research lesson whose context/diagram come from the assembler. */
function assembledLesson() {
  const input = assembleInput({
    pages: ["guides/intro.md", "src/index.ts"],
    coverage: emptyCoverage(["src/index.ts", "src/app.ts"]),
  });
  const draft = researchLesson();
  draft.context = assembleContext(input);
  draft.overview = assembleOverview(input);
  draft.diagram = assembleComponentDiagram(input);
  const candidates = assembleScenarioCandidates(input);
  const primary = candidates[0];
  if (primary === undefined) throw new Error("assembler produced no scenario");
  draft.scenario = primary;
  return { input, draft, candidateKinds: candidates.map((c) => c.kind) };
}

describe("upstream mermaid validation × lesson diagram gate", () => {
  it("accepts the assembled component diagram through both layers", async () => {
    const { input, draft } = assembledLesson();
    const parsed = parseLesson(draft);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Deterministic: the same input reassembles byte-identically.
    expect(assembleComponentDiagram(input)).toEqual(parsed.lesson.diagram);
    expect(parsed.lesson.diagram.kind).toBe("component");
    expect(scenarioKindFor(input)).toBe("library_interface");
    expect(diagramPurposeOf(parsed.lesson)).toBe("module_relation");

    const port = createUpstreamMermaidPort();
    const validation = await port.validate(parsed.lesson.diagram.mermaid);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(["strict", "heuristic"]).toContain(validation.mode);
    }

    await expect(publishGate(draft, port)).resolves.toEqual({ ok: true });
  });

  it("never offers a user_flow scenario for a library-only checkout", async () => {
    const { candidateKinds, draft } = assembledLesson();
    expect(candidateKinds).not.toContain("user_flow");
    expect(draft.scenario).toMatchObject({
      kind: "library_interface",
      isExample: true,
    });
  });

  it("rejects a diagram kind that does not fit the lesson's purpose", async () => {
    const { draft } = assembledLesson();
    const mutable = draft.diagram as { kind: string };
    // Valid mermaid, valid schema — but a component diagram cannot show a
    // request round-trip, and `assertDiagramKind` owns that rule.
    mutable.kind = "sequence";

    const parsed = parseLesson(draft);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(diagramPurposeOf(parsed.lesson)).toBe("module_relation");
    expect(() =>
      assertDiagramKind(diagramPurposeOf(parsed.lesson), "sequence"),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));

    const port = createUpstreamMermaidPort();
    const result = await publishGate(draft, port);
    expect(result).toMatchObject({ ok: false, stage: "purpose" });
  });

  it("blocks publication when the mermaid body itself does not parse", async () => {
    const draft = changeLesson();
    const diagram = draft.diagram as { kind: string; mermaid: string };
    // `end` is a reserved flowchart id: upstream rejects it in both modes.
    diagram.mermaid = "flowchart TD\n  end[Reserved node id]";

    const parsed = parseLesson(draft);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The kind mapping is satisfied; only the parser can see the defect.
    expect(() =>
      assertDiagramKind(diagramPurposeOf(parsed.lesson), diagram.kind),
    ).not.toThrow();

    const port = createUpstreamMermaidPort();
    const result = await publishGate(draft, port);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("mermaid");
    expect(result.message).toBeTruthy();
  });
});
