/**
 * Diagram validation (architecture §9.4, AC-LES-10/11).
 *
 * Two independent checks:
 *
 * - `diagram_evidence`: every node/edge citation resolves to a source in this
 *   generation, endpoints name declared nodes, and a non-inferred edge cites
 *   something. The status flags (`observed`/`inferred`/`planned`/`demo`) are
 *   preserved by `toRenderData`.
 * - `diagram_mermaid`: the diagram must parse in strict or heuristic mode. A
 *   genuine parse failure marks `checks.structural = "failed"` and blocks
 *   publish; an unavailable parser is not a failure (the port reports
 *   `mode: "heuristic"`).
 */

import type {
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from "../../contracts/index.js";
import type { AnyLesson } from "../schema.js";
import { bindNodeEvidence } from "../diagram.js";
import { safeGetRef } from "./evidence.js";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return {
    code,
    message: path === undefined ? message : `${path}: ${message}`,
    ...(path === undefined ? {} : { path }),
  };
}

function validateDiagramEvidence(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(lesson.diagram.nodes.map((node) => node.id));

  for (const node of lesson.diagram.nodes) {
    issues.push(...bindNodeEvidence(node, ctx).issues);
  }

  lesson.diagram.edges.forEach((edge, index) => {
    const path = `diagram.edges.${index}`;
    if (!nodeIds.has(edge.from)) {
      issues.push(
        issue("diagram_evidence", `undeclared node ${edge.from}`, path),
      );
    }
    if (!nodeIds.has(edge.to)) {
      issues.push(
        issue("diagram_evidence", `undeclared node ${edge.to}`, path),
      );
    }
    if (!edge.inferred && edge.evidenceIds.length === 0) {
      issues.push(
        issue(
          "diagram_evidence",
          "observed edge must cite at least one source or be marked inferred",
          path,
        ),
      );
    }
    for (const sourceId of edge.evidenceIds) {
      if (safeGetRef(ctx, sourceId) === null) {
        issues.push(
          issue(
            "diagram_evidence",
            `evidence id ${sourceId} is not registered to this generation`,
            path,
          ),
        );
      }
    }
  });

  return issues;
}

/**
 * The diagram gate (AC-LES-10/11). `validateDiagram` returns every issue so
 * the caller can distinguish an evidence failure from a parse failure.
 */
export async function validateDiagram(
  lesson: AnyLesson,
  ctx: ValidationContext,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [
    ...validateDiagramEvidence(lesson, ctx),
  ];

  if (lesson.diagram.mermaid.trim() === "") {
    issues.push(
      issue("diagram_mermaid", "diagram has no mermaid body", "diagram.mermaid"),
    );
  } else {
    const parsed = await ctx.mermaid.validate(lesson.diagram.mermaid);
    if (!parsed.ok) {
      issues.push(
        issue(
          "diagram_mermaid",
          `mermaid failed to parse: ${parsed.message}`,
          "diagram.mermaid",
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
