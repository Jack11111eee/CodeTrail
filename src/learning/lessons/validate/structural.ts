/**
 * Structural validation (architecture §9.4).
 *
 * The schema gate runs first (`parseLesson`) so every later rule can assume a
 * well-formed lesson. This validator owns the cross-field rules that need more
 * than shape: the two-layer contract (AC-LES-03), choices and their omissions
 * (AC-LES-04), boundary statuses (AC-LES-05), the scenario/diagram kind
 * selected for the project (AC-LES-09/12), coverage gaps (AC-LES-13) and the
 * change-record completeness rules (AC-UPD-27).
 */

import type {
  LessonKind,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from "../../contracts/index.js";
import type { AnyLesson } from "../schema.js";
import { DIAGRAM_KIND_BY_PURPOSE, diagramPurposeOf, parseLesson } from "../schema.js";
import { isDesignDoc, safeGetRef } from "./evidence.js";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return {
    code,
    message: path === undefined ? message : `${path}: ${message}`,
    ...(path === undefined ? {} : { path }),
  };
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** AC-LES-03: the layers describe the same mechanisms, in different words. */
function validateLayering(lesson: AnyLesson): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const technical = new Map(
    lesson.technicalExplanation.map((entry) => [entry.mechanismId, entry]),
  );
  const plain = new Map(
    lesson.plainExplanation.map((entry) => [entry.mechanismId, entry]),
  );

  for (const entry of lesson.plainExplanation) {
    const layered = technical.get(entry.mechanismId);
    if (layered === undefined) {
      issues.push(
        issue(
          "layering",
          `plainExplanation mechanism ${entry.mechanismId} has no technicalExplanation`,
          "plainExplanation",
        ),
      );
      continue;
    }
    if (entry.text.trim() === layered.text.trim()) {
      issues.push(
        issue(
          "layering",
          `mechanism ${entry.mechanismId} uses the same text in both layers`,
          "plainExplanation",
        ),
      );
    }
  }

  for (const entry of lesson.technicalExplanation) {
    if (!plain.has(entry.mechanismId)) {
      issues.push(
        issue(
          "layering",
          `technicalExplanation mechanism ${entry.mechanismId} has no plainExplanation`,
          "technicalExplanation",
        ),
      );
    }
  }

  return issues;
}

/** AC-LES-04: empty choices need a reason; alternatives need the full story. */
function validateChoices(lesson: AnyLesson): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (lesson.choices.length === 0) {
    if (!nonEmpty(lesson.choicesOmittedReason)) {
      issues.push(
        issue(
          "choices",
          "choicesOmittedReason is required when choices is empty",
          "choicesOmittedReason",
        ),
      );
    }
    return issues;
  }

  lesson.choices.forEach((choice, index) => {
    if (choice.evidenceIds.length === 0) {
      issues.push(
        issue("choices", "choice needs evidence", `choices.${index}`),
      );
    }
    choice.alternatives.forEach((alternative, altIndex) => {
      const path = `choices.${index}.alternatives.${altIndex}`;
      if (!nonEmpty(alternative.whenItFits)) {
        issues.push(issue("choices", "alternative needs whenItFits", path));
      }
      if (!nonEmpty(alternative.cost)) {
        issues.push(issue("choices", "alternative needs cost", path));
      }
      if (alternative.evidenceIds.length === 0) {
        issues.push(issue("choices", "alternative needs evidence", path));
      }
    });
  });

  return issues;
}

/** AC-LES-05: four statuses, each backed by the evidence it requires. */
function validateBoundaries(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  lesson.boundaries.forEach((boundary, index) => {
    const path = `boundaries.${index}`;
    const refs = boundary.evidenceIds
      .map((id) => safeGetRef(ctx, id))
      .filter((ref) => ref !== null);
    const hasRepo = refs.some((ref) => ref.kind === "repo");
    const hasDesignDoc = refs.some((ref) => isDesignDoc(ref));

    if (boundary.status === "implemented" && !hasRepo) {
      issues.push(
        issue(
          "boundaries",
          hasDesignDoc
            ? "implemented boundary has only design-doc evidence; downgrade it to unknown and state a reason"
            : "implemented boundary needs a repository source",
          path,
        ),
      );
    }

    if (boundary.status === "planned" && !hasDesignDoc) {
      issues.push(
        issue(
          "boundaries",
          "planned boundary needs a design-document source",
          path,
        ),
      );
    }
  });

  return issues;
}

/** AC-LES-12: a project with no UI surface cannot claim a user flow. */
function validateScenarioKind(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  if (!ctx.isUiProject && lesson.scenario.kind === "user_flow") {
    return [
      issue(
        "scenario_kind",
        "user_flow requires a project with a UI surface",
        "scenario.kind",
      ),
    ];
  }
  return [];
}

/** AC-LES-09: the diagram kind must fit the lesson's purpose. */
function validateDiagramKind(lesson: AnyLesson): ValidationIssue[] {
  const purpose = diagramPurposeOf(lesson);
  const allowed = DIAGRAM_KIND_BY_PURPOSE[purpose];
  if (!allowed.includes(lesson.diagram.kind)) {
    return [
      issue(
        "diagram_kind",
        `kind ${lesson.diagram.kind} does not fit purpose ${purpose}`,
        "diagram.kind",
      ),
    ];
  }
  return [];
}

/** AC-LES-13: incomplete coverage must be declared in `coverageGaps`. */
function validateCoverage(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  if (!ctx.coverage.complete && lesson.coverageGaps.length === 0) {
    return [
      issue(
        "coverage",
        "coverageGaps must list the files that were not analyzed",
        "coverageGaps",
      ),
    ];
  }
  return [];
}

const CHANGE_ARRAY_FIELDS = [
  "affectedModules",
  "keyTechnologies",
  "alternatives",
  "unverifiedEffects",
] as const;

/** AC-UPD-27: empty change-record members carry an explicit omission reason. */
function validateChangeFields(lesson: AnyLesson): ValidationIssue[] {
  if (lesson.kind !== "change") return [];
  const issues: ValidationIssue[] = [];

  for (const field of CHANGE_ARRAY_FIELDS) {
    if (
      lesson[field].length === 0 &&
      !nonEmpty(lesson.omittedReasons[field])
    ) {
      issues.push(
        issue(
          "change_fields",
          `${field} is empty; add an omittedReasons entry`,
          field,
        ),
      );
    }
  }

  if (!nonEmpty(lesson.behaviorChange.before) &&
      !nonEmpty(lesson.omittedReasons.behaviorChange)) {
    issues.push(
      issue(
        "change_fields",
        "behaviorChange.before is empty; add an omittedReasons entry",
        "behaviorChange",
      ),
    );
  }
  if (!nonEmpty(lesson.behaviorChange.after) &&
      !nonEmpty(lesson.omittedReasons.behaviorChange)) {
    issues.push(
      issue(
        "change_fields",
        "behaviorChange.after is empty; add an omittedReasons entry",
        "behaviorChange",
      ),
    );
  }
  if (lesson.evidence.length === 0 &&
      !nonEmpty(lesson.omittedReasons.evidence)) {
    issues.push(
      issue(
        "change_fields",
        "evidence is empty; add an omittedReasons entry",
        "evidence",
      ),
    );
  }

  return issues;
}

const EXPECTED_KIND: Readonly<Record<ValidationContext["mode"], LessonKind>> =
  Object.freeze({
    research: "research",
    change: "change",
    comparison: "comparison",
  });

/**
 * Schema failures that correspond to exactly one §9.4 rule keep that rule's
 * code, so a caller can distinguish "empty choices without a reason" from a
 * missing required group. Everything else is a generic structural failure.
 */
function codeForFailure(path: string): string {
  if (path.startsWith("choices") || path.startsWith("choicesOmittedReason")) {
    return "choices";
  }
  if (
    path.startsWith("plainExplanation") ||
    path.startsWith("technicalExplanation")
  ) {
    return "layering";
  }
  if (path.startsWith("boundaries")) return "boundaries";
  if (
    path.startsWith("behaviorChange") ||
    path.startsWith("affectedModules") ||
    path.startsWith("keyTechnologies") ||
    path.startsWith("unverifiedEffects") ||
    path.startsWith("omittedReasons") ||
    path === "alternatives"
  ) {
    return "change_fields";
  }
  if (path.startsWith("context.comparison")) return "evidence_compare";
  if (/^statements\.\d+\.side$/u.test(path)) return "evidence_compare";
  if (path.startsWith("diagram.kind")) return "diagram_kind";
  if (path.startsWith("diagram.")) return "diagram_evidence";
  if (path.startsWith("scenario.kind")) return "scenario_kind";
  if (path.startsWith("scenario.isExample")) return "example_label";
  return "structural";
}

/**
 * The structural gate (AC-LES-03/04/05/06/09/12/13). A failure here means the
 * lesson must be dropped, never published partially (§9.5).
 */
export function validateStructural(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationResult {
  const parsed = parseLesson(lesson, { isUiProject: ctx.isUiProject });
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.failures.map((failure) =>
        issue(codeForFailure(failure.path), failure.message, failure.path),
      ),
    };
  }

  const valid = parsed.lesson;
  const issues: ValidationIssue[] = [];

  if (valid.kind !== EXPECTED_KIND[ctx.mode]) {
    issues.push(
      issue(
        "structural",
        `mode ${ctx.mode} cannot build a ${valid.kind} lesson`,
        "kind",
      ),
    );
  }

  issues.push(
    ...validateLayering(valid),
    ...validateChoices(valid),
    ...validateBoundaries(valid, ctx),
    ...validateScenarioKind(valid, ctx),
    ...validateDiagramKind(valid),
    ...validateCoverage(valid, ctx),
    ...validateChangeFields(valid),
  );

  return { ok: issues.length === 0, issues };
}
