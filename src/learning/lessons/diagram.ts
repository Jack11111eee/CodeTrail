/**
 * Diagram mapping and render projection (architecture §9.6).
 *
 * The purpose → kind table lives in `schema.ts` because the structural gate
 * needs it too; this module re-exports it rather than keeping a second copy.
 * `bindNodeEvidence` is the single place a diagram node's evidence is checked,
 * and `toRenderData` is a pure projection the HTTP layer exposes.
 */

import type {
  DiagramNode,
  RenderDiagram,
  ValidationContext,
  ValidationResult,
} from "../contracts/index.js";
import { isRecord, safeGetRef } from "./validate/evidence.js";
import type { AnyLesson } from "./schema.js";

export {
  DIAGRAM_KIND_BY_PURPOSE,
  assertDiagramKind,
  diagramPurposeOf,
} from "./schema.js";
export type { DiagramPurpose } from "./schema.js";

export type { RenderDiagram };

interface DiagramIssue {
  code: string;
  message: string;
  path?: string;
}

function issue(code: string, message: string, path?: string): DiagramIssue {
  return {
    code,
    message: path === undefined ? message : `${path}: ${message}`,
    ...(path === undefined ? {} : { path }),
  };
}

/**
 * True when the node's declared status needs supporting evidence.
 * Observed nodes are claims about the repository; inferred/planned/demo nodes
 * are explicitly marked as not observed, so they may cite nothing.
 */
function statusNeedsEvidence(node: DiagramNode): boolean {
  return node.status === "observed";
}

/**
 * Validates one node's evidence (AC-LES-10). Every cited id must belong to the
 * generation, and an `observed` node must cite at least one source: a node the
 * diagram claims to have seen cannot stand on nothing.
 */
export function bindNodeEvidence(
  node: DiagramNode,
  ctx: ValidationContext,
): ValidationResult {
  const issues: DiagramIssue[] = [];

  if (statusNeedsEvidence(node) && node.evidenceIds.length === 0) {
    issues.push(
      issue(
        "diagram_evidence",
        "observed node must cite at least one source",
        `diagram.nodes.${node.id}`,
      ),
    );
  }

  for (const sourceId of node.evidenceIds) {
    if (safeGetRef(ctx, sourceId) === null) {
      issues.push(
        issue(
          "diagram_evidence",
          `evidence id ${sourceId} is not registered to this generation`,
          `diagram.nodes.${node.id}`,
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

function edgeId(edge: { from: string; to: string }): string {
  return `${edge.from}->${edge.to}`;
}

/**
 * Render-side projection (AC-LES-10). Boolean/flag information the UI needs is
 * surfaced as id lists so a renderer never has to re-derive it.
 */
export function toRenderData(lesson: AnyLesson): RenderDiagram {
  const nodes = lesson.diagram.nodes;
  const edges = lesson.diagram.edges;

  return {
    kind: lesson.diagram.kind,
    commitSha: lesson.context.commitSha,
    nodes,
    edges,
    mermaid: lesson.diagram.mermaid,
    inferredEdgeIds: [
      ...new Set(edges.filter((edge) => edge.inferred).map(edgeId)),
    ],
    plannedNodeIds: nodes
      .filter((node) => node.status === "planned")
      .map((node) => node.id),
    demoNodeIds: nodes
      .filter((node) => node.status === "demo")
      .map((node) => node.id),
  };
}

/** Narrowing helper used by callers that only need the mutable fields. */
export function isLessonRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
