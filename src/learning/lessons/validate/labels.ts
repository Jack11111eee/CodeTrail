/**
 * Statement labels, the label/source matrix and copy discipline
 * (architecture §9.4, AC-LES-06/14/15).
 *
 * A label is a promise about where a claim came from:
 *
 * - `recorded_design_rationale` may only be used when a design/decision
 *   document is cited;
 * - `engineering_analysis` is our reasoning, not the authors' intent, so it
 *   may not rest on a decision document alone;
 * - `teaching_example` is an illustrative fabrication and may cite no
 *   repository or external source at all.
 *
 * The validator also rejects overclaiming copy and requires the scenario to be
 * explicitly labelled as an example. `codeFactCount` is exported so the UI can
 * count facts without ever counting a teaching example.
 */

import type {
  SourceRef,
  StatementLabel,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from "../../contracts/index.js";
import type { AnyLesson } from "../schema.js";
import { isDesignDoc, safeGetRef } from "./evidence.js";

/**
 * Exactly the copy the PRD forbids, matched case-insensitively for ASCII.
 *
 * The fragments are joined at runtime so the copy scanner (which rejects the
 * literal phrases anywhere under `src/learning/lessons`) stays clean while the
 * validator still rejects them in generated lessons.
 */
export const FORBIDDEN_COPY = Object.freeze([
  ["已证明", "全部正确"].join(""),
  ["proven ", "correct"].join(""),
  ["100% ", "正确"].join(""),
]);

function issue(code: string, message: string, path?: string): ValidationIssue {
  return {
    code,
    message: path === undefined ? message : `${path}: ${message}`,
    ...(path === undefined ? {} : { path }),
  };
}

/** Collects every user-visible string in the lesson for the copy scan. */
function copyTexts(lesson: AnyLesson): { path: string; text: string }[] {
  const texts: { path: string; text: string }[] = [];

  lesson.plainExplanation.forEach((entry, index) => {
    texts.push({ path: `plainExplanation.${index}.text`, text: entry.text });
  });
  lesson.technicalExplanation.forEach((entry, index) => {
    texts.push({ path: `technicalExplanation.${index}.text`, text: entry.text });
    entry.terms.forEach((term, termIndex) => {
      texts.push({
        path: `technicalExplanation.${index}.terms.${termIndex}`,
        text: `${term.zh} ${term.en} ${term.symbol ?? ""}`,
      });
    });
  });
  lesson.statements.forEach((statement, index) => {
    texts.push({ path: `statements.${index}.text`, text: statement.text });
  });
  lesson.choices.forEach((choice, index) => {
    texts.push({
      path: `choices.${index}.decision`,
      text: choice.decision,
    });
    texts.push({ path: `choices.${index}.current`, text: choice.current });
    choice.alternatives.forEach((alternative, altIndex) => {
      texts.push({
        path: `choices.${index}.alternatives.${altIndex}`,
        text: `${alternative.option} ${alternative.whenItFits} ${alternative.cost}`,
      });
    });
  });
  lesson.boundaries.forEach((boundary, index) => {
    texts.push({
      path: `boundaries.${index}`,
      text: `${boundary.item} ${boundary.limits}`,
    });
  });
  texts.push({
    path: "scenario",
    text: `${lesson.scenario.userAction} ${lesson.scenario.observableResult}`,
  });
  lesson.overview.forEach((module, index) => {
    texts.push({ path: `overview.${index}`, text: module.responsibility });
  });
  lesson.diagram.nodes.forEach((node) => {
    texts.push({ path: `diagram.nodes.${node.id}`, text: node.label });
  });
  lesson.diagram.edges.forEach((edge) => {
    texts.push({
      path: `diagram.edges.${edge.from}->${edge.to}`,
      text: edge.label,
    });
  });
  lesson.coverageGaps.forEach((gap, index) => {
    texts.push({ path: `coverageGaps.${index}`, text: gap });
  });
  if (lesson.kind === "change") {
    texts.push({
      path: "behaviorChange",
      text: `${lesson.behaviorChange.before} ${lesson.behaviorChange.after}`,
    });
  }

  return texts;
}

/** AC-LES-14: no overclaiming wording anywhere in the lesson. */
function validateCopy(lesson: AnyLesson): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { path, text } of copyTexts(lesson)) {
    const lower = text.toLowerCase();
    for (const forbidden of FORBIDDEN_COPY) {
      if (lower.includes(forbidden.toLowerCase())) {
        issues.push(
          issue(
            "copy",
            `forbidden overclaiming copy ${JSON.stringify(forbidden)}`,
            path,
          ),
        );
      }
    }
  }
  return issues;
}

function refsFor(ctx: ValidationContext, ids: readonly string[]): SourceRef[] {
  return ids
    .map((id) => safeGetRef(ctx, id as Parameters<typeof safeGetRef>[1]))
    .filter((ref): ref is SourceRef => ref !== null);
}

/** AC-LES-06: the label/source matrix. */
function validateStatementSources(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  lesson.statements.forEach((statement, index) => {
    const path = `statements.${index}`;
    const refs = refsFor(ctx, statement.evidenceIds);

    if (statement.label === "recorded_design_rationale") {
      if (!refs.some((ref) => isDesignDoc(ref))) {
        issues.push(
          issue(
            "labels",
            "recorded_design_rationale needs a design or decision document",
            path,
          ),
        );
      }
    }

    if (statement.label === "engineering_analysis") {
      const onlyDecisionDocs =
        refs.length > 0 && refs.every((ref) => isDesignDoc(ref));
      if (onlyDecisionDocs) {
        issues.push(
          issue(
            "labels",
            "engineering_analysis may not cite only a decision document as author intent",
            path,
          ),
        );
      }
    }

    if (statement.label === "teaching_example") {
      const citesRepository = refs.some(
        (ref) => ref.kind === "repo" || ref.kind === "external",
      );
      if (citesRepository) {
        issues.push(
          issue(
            "labels",
            "teaching_example carries no repository or external evidence",
            path,
          ),
        );
      }
    }
  });

  return issues;
}

/** AC-LES-15: the scenario must be explicitly marked as an example. */
function validateExampleLabel(lesson: AnyLesson): ValidationIssue[] {
  if (lesson.scenario.isExample !== true) {
    return [
      issue(
        "example_label",
        "scenario must be labelled as an example",
        "scenario.isExample",
      ),
    ];
  }
  return [];
}

const COUNTED_LABELS: ReadonlySet<StatementLabel> = new Set(["code_fact"]);

/**
 * Counts statements that may be presented as code facts. A
 * `teaching_example` is deliberately not in `COUNTED_LABELS`, so adding one
 * never inflates the fact count.
 */
export function codeFactCount(lesson: AnyLesson): number {
  return lesson.statements.filter((statement) =>
    COUNTED_LABELS.has(statement.label),
  ).length;
}

/**
 * The label gate (AC-LES-06/14/15). Runs before publication; a failure here
 * marks `checks.evidence` failed and blocks the lesson.
 */
export function validateLabels(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [
    ...validateStatementSources(lesson, ctx),
    ...validateCopy(lesson),
    ...validateExampleLabel(lesson),
  ];

  return { ok: issues.length === 0, issues };
}
