/**
 * Inline SVG diagram renderer (architecture §15, AC-UI-04).
 *
 * The renderer never executes Mermaid: the validated source is shown as inert,
 * escaped text and the interactive graph is our own SVG. Every node carries
 * the evidence ids and the generation's commit that were bound when the lesson
 * was built, so a click can submit exactly that selection context — never the
 * repository's latest commit.
 */

import type { DiagramKind, RenderDiagram } from "../../contracts/index.js";
import { escapeAttribute, escapeHtml } from "./markdown.js";

const PURPOSE_LABEL: Readonly<Record<DiagramKind, string>> = {
  component: "模块依赖",
  sequence: "运行流程",
  state: "版本变化",
  timeline: "变更时间线",
};

const CELL_WIDTH = 220;
const CELL_HEIGHT = 104;
const PADDING = 28;
const SEQUENCE_STEP = 180;

/** `diagram-component` / `diagram-sequence` / `diagram-state` / `diagram-timeline`. */
export function diagramTestId(kind: DiagramKind): string {
  return `diagram-${kind}`;
}

/** Human label for the purpose that produced this kind. */
export function diagramPurposeLabel(kind: DiagramKind): string {
  return PURPOSE_LABEL[kind];
}

interface Point {
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodePoints(diagram: RenderDiagram): {
  width: number;
  height: number;
  points: Map<string, Point>;
} {
  const nodes = diagram.nodes;
  const points = new Map<string, Point>();

  if (diagram.kind === "sequence" || diagram.kind === "timeline") {
    const width =
      PADDING * 2 + Math.max(1, nodes.length - 1) * SEQUENCE_STEP + CELL_WIDTH;
    const height = PADDING * 2 + CELL_HEIGHT * 2;
    nodes.forEach((node, index) => {
      points.set(node.id, {
        x: PADDING + index * SEQUENCE_STEP,
        y: PADDING,
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
      });
    });
    return { width, height, points };
  }

  const columns = Math.max(1, Math.min(3, nodes.length));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  const width = PADDING * 2 + columns * CELL_WIDTH;
  const height = PADDING * 2 + rows * CELL_HEIGHT;
  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    points.set(node.id, {
      x: PADDING + column * CELL_WIDTH,
      y: PADDING + row * CELL_HEIGHT,
      width: CELL_WIDTH - 20,
      height: CELL_HEIGHT - 24,
    });
  });
  return { width, height, points };
}

function badgeFor(nodeId: string, diagram: RenderDiagram): string {
  if (diagram.plannedNodeIds.includes(nodeId)) return "（计划）";
  if (diagram.demoNodeIds.includes(nodeId)) return "（示例）";
  return "";
}

function renderNode(
  node: RenderDiagram["nodes"][number],
  point: Point,
  diagram: RenderDiagram,
): string {
  const planned = diagram.plannedNodeIds.includes(node.id);
  const demo = diagram.demoNodeIds.includes(node.id);
  const badge = badgeFor(node.id, diagram);
  const evidenceIds = node.evidenceIds.join(",");
  const radius = diagram.kind === "state" ? 18 : 6;
  const label = escapeHtml(node.label);
  const labelY = point.y + point.height / 2 + 4;
  const badgeY = point.y + point.height / 2 + 24;
  const badgeMarkup =
    badge === ""
      ? ""
      : `<text class="diagram-badge" x="${String(point.x + 10)}" y="${String(badgeY)}" font-size="11">${escapeHtml(badge)}</text>`;

  return (
    `<g class="diagram-node" data-diagram-node="true" data-node-id="${escapeAttribute(node.id)}" ` +
    `data-evidence-ids="${escapeAttribute(evidenceIds)}" ` +
    `data-commit-sha="${escapeAttribute(diagram.commitSha)}" ` +
    `data-status="${escapeAttribute(node.status)}" ` +
    `data-planned="${planned ? "true" : "false"}" data-demo="${demo ? "true" : "false"}" ` +
    `tabindex="0" role="button" aria-label="${escapeAttribute(node.label)}">` +
    `<title>${label}</title>` +
    `<rect x="${String(point.x)}" y="${String(point.y)}" width="${String(point.width)}" ` +
    `height="${String(point.height)}" rx="${String(radius)}" ry="${String(radius)}"></rect>` +
    `<text x="${String(point.x + point.width / 2)}" y="${String(labelY)}" text-anchor="middle">${label}</text>` +
    badgeMarkup +
    `</g>`
  );
}

function renderEdge(
  edge: RenderDiagram["edges"][number],
  points: Map<string, Point>,
  diagram: RenderDiagram,
): string {
  const from = points.get(edge.from);
  const to = points.get(edge.to);
  if (from === undefined || to === undefined) return "";

  const edgeId = `${edge.from}->${edge.to}`;
  const inferred = edge.inferred || diagram.inferredEdgeIds.includes(edgeId);
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  const labelX = (x1 + x2) / 2;
  const labelY = (y1 + y2) / 2;
  const label = inferred ? `${edge.label}（推断）` : edge.label;

  return (
    `<g class="diagram-edge" data-edge-id="${escapeAttribute(edgeId)}" ` +
    `data-evidence-ids="${escapeAttribute(edge.evidenceIds.join(","))}" ` +
    `data-inferred="${inferred ? "true" : "false"}">` +
    `<line x1="${String(x1)}" y1="${String(y1)}" x2="${String(x2)}" y2="${String(y2)}" ` +
    `marker-end="url(#diagram-arrow-${diagram.kind})"></line>` +
    `<text x="${String(labelX)}" y="${String(labelY)}" text-anchor="middle" font-size="11">${escapeHtml(label)}</text>` +
    `</g>`
  );
}

/**
 * Renders one diagram. The root carries `data-diagram-kind`, the bound commit
 * and the flag lists; each node carries its own evidence ids and that same
 * commit.
 */
export function renderDiagram(diagram: RenderDiagram): string {
  const { width, height, points } = nodePoints(diagram);
  const purpose = PURPOSE_LABEL[diagram.kind] ?? diagram.kind;
  const nodes = diagram.nodes
    .map((node) => {
      const point = points.get(node.id);
      return point === undefined ? "" : renderNode(node, point, diagram);
    })
    .join("");
  const edges = diagram.edges
    .map((edge) => renderEdge(edge, points, diagram))
    .join("");

  return (
    `<figure class="diagram-figure" data-diagram-kind="${escapeAttribute(diagram.kind)}">` +
    `<figcaption>${escapeHtml(purpose)}（${escapeHtml(diagram.kind)}）</figcaption>` +
    `<svg class="diagram" data-testid="${diagramTestId(diagram.kind)}" ` +
    `data-diagram-kind="${escapeAttribute(diagram.kind)}" ` +
    `data-commit-sha="${escapeAttribute(diagram.commitSha)}" ` +
    `data-planned-nodes="${escapeAttribute(diagram.plannedNodeIds.join(","))}" ` +
    `data-demo-nodes="${escapeAttribute(diagram.demoNodeIds.join(","))}" ` +
    `data-inferred-edges="${escapeAttribute(diagram.inferredEdgeIds.join(","))}" ` +
    `viewBox="0 0 ${String(width)} ${String(height)}" role="img" ` +
    `aria-label="${escapeAttribute(purpose)}">` +
    `<defs><marker id="diagram-arrow-${escapeAttribute(diagram.kind)}" viewBox="0 0 10 10" ` +
    `refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>` +
    nodes +
    edges +
    `</svg>` +
    `<details class="diagram-source" data-collapsed="true">` +
    `<summary>Mermaid 源（只读文本，不会执行）</summary>` +
    `<pre><code class="language-mermaid">${escapeHtml(diagram.mermaid)}</code></pre>` +
    `</details>` +
    `</figure>`
  );
}
