import { describe, expect, it } from "vitest";

import { renderDiagram } from "../../../src/learning/ui/render/diagram.ts";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import {
  diagram,
  HEAD_SHA,
  lessonDetail,
  OTHER_SHA,
  pageContext,
  readerModel,
} from "./fixtures.ts";

/** AC-UI-04: kind → testid, bound evidence/commit and flag surfacing. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("diagram renderer", () => {
  it.each([
    ["component", "diagram-component"],
    ["sequence", "diagram-sequence"],
    ["state", "diagram-state"],
  ] as const)("renders a %s diagram under %s", (kind, testid) => {
    const html = renderDiagram(diagram(kind));
    expect(countTestId(html, testid)).toBe(1);
    expect(html).toContain(`data-diagram-kind="${kind}"`);
    expect(html).toContain(`data-commit-sha="${HEAD_SHA}"`);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script");
  });

  it("carries per-node evidence ids and the generation commit", () => {
    const html = renderDiagram(diagram("component"));
    expect(html).toContain('data-node-id="n1"');
    expect(html).toContain('data-evidence-ids="s_0123456789abcdef"');
    expect(html).toContain('data-node-id="n2"');
    expect(html).toContain('data-evidence-ids="s_second"');
    // A node click submits the bound commit, never the repository's latest.
    expect(html).toContain(`data-commit-sha="${HEAD_SHA}"`);
    expect(html).not.toContain(OTHER_SHA);
  });

  it("surfaces planned, demo and inferred flags", () => {
    const html = renderDiagram(
      diagram("state", {
        plannedNodeIds: ["n1"],
        demoNodeIds: ["n2"],
        inferredEdgeIds: ["n1->n2"],
      }),
    );
    expect(html).toContain('data-planned="true"');
    expect(html).toContain('data-demo="true"');
    expect(html).toContain('data-inferred="true"');
    expect(html).toContain('data-planned-nodes="n1"');
    expect(html).toContain('data-demo-nodes="n2"');
    expect(html).toContain('data-inferred-edges="n1->n2"');
    expect(html).toContain("（计划）");
    expect(html).toContain("（示例）");
    expect(html).toContain("（推断）");
  });

  it("shows the Mermaid source as inert text", () => {
    const html = renderDiagram(diagram("component"));
    expect(html).toContain("Mermaid 源（只读文本，不会执行）");
    expect(html).toContain("flowchart LR");
    expect(html).not.toContain("mermaid.min.js");
    expect(html).not.toContain("mermaid.initialize");
  });

  it("renders the active lesson's kind on the reader", () => {
    for (const [kind, testid] of [
      ["component", "diagram-component"],
      ["sequence", "diagram-sequence"],
      ["state", "diagram-state"],
    ] as const) {
      const html = renderReaderPage(
        pageContext,
        readerModel({ activeLesson: lessonDetail(kind) }),
      );
      expect(countTestId(html, testid), kind).toBe(1);
    }
  });

  it("submits the node's evidence and bound commit as the selection context", () => {
    const html = renderReaderPage(pageContext, readerModel());
    // The client copies these attributes into the QA form's hidden fields, so a
    // click can never be answered against the repository's latest commit.
    expect(html).toContain("data-qa-selection-source");
    expect(html).toContain("data-qa-selection-commit");
    expect(html).toContain('data-evidence-ids="s_0123456789abcdef"');
    expect(html).toContain(`data-commit-sha="${HEAD_SHA}"`);
    expect(html).not.toContain(OTHER_SHA);
  });

  it("renders a node with no evidence without inventing an id", () => {
    const html = renderDiagram(
      diagram("component", {
        nodes: [
          {
            id: "n3",
            label: "orphan",
            evidenceIds: [],
            status: "planned",
          },
        ],
        edges: [],
      }),
    );
    expect(html).toContain('data-node-id="n3"');
    expect(html).toContain('data-evidence-ids=""');
  });

  it("drops edges whose endpoints are absent", () => {
    const html = renderDiagram(
      diagram("component", {
        edges: [
          {
            from: "n1",
            to: "missing",
            label: "悬空",
            evidenceIds: [],
            inferred: false,
          },
        ],
      }),
    );
    expect(html).not.toContain('data-edge-id="n1->missing"');
    expect(html).toContain('data-node-id="n1"');
  });

  it("renders an empty diagram without crashing", () => {
    const html = renderDiagram(diagram("sequence", { nodes: [], edges: [] }));
    expect(countTestId(html, "diagram-sequence")).toBe(1);
    expect(html).not.toContain("data-node-id");
    expect(html).toContain("Mermaid 源（只读文本，不会执行）");
  });
});
