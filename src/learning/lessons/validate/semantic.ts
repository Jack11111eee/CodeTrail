/**
 * Semantic validation and the capped repair loop (architecture §9.4,
 * AC-LES-17).
 *
 * A statement is semantically supported when every citation resolves to a
 * source registered for this generation and the statement is not a bare
 * teaching example presented as a fact. `validateSemantic` asks for **at most
 * one** targeted repair; if the repaired lesson is still unsupported, exactly
 * one of three downgrades is applied:
 *
 *   - delete the conclusion (`code_fact` with no support),
 *   - downgrade it to analysis (a design rationale becomes analysis),
 *   - relabel it as explicit speculation (prefix the text).
 *
 * The original strength is never preserved, so `checks.semantic` can only
 * record `pass` when every remaining statement is supported.
 */

import type {
  Lesson,
  SemanticRepairFn,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from "../../contracts/index.js";
import type { AnyLesson } from "../schema.js";
import { safeGetRef } from "./evidence.js";

/** Markers that make a statement explicitly speculative and therefore allowed. */
const SPECULATION_MARKERS = [
  "推测：",
  "推测:",
  "推测 ",
  "speculative:",
  "speculation:",
  "likely:",
] as const;

function issue(code: string, message: string, path?: string): ValidationIssue {
  return {
    code,
    message: path === undefined ? message : `${path}: ${message}`,
    ...(path === undefined ? {} : { path }),
  };
}

function isExplicitSpeculation(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return SPECULATION_MARKERS.some((marker) =>
    trimmed.startsWith(marker.toLowerCase()),
  );
}

/** Statements that make a factual/authorial claim need resolvable evidence. */
function unsupportedStatements(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  lesson.statements.forEach((statement, index) => {
    const path = `statements.${index}`;
    if (statement.label === "teaching_example") return;
    if (isExplicitSpeculation(statement.text)) return;

    if (statement.evidenceIds.length === 0) {
      issues.push(
        issue("semantic", "statement has no supporting evidence", path),
      );
      return;
    }

    const refs = statement.evidenceIds
      .map((id) => safeGetRef(ctx, id))
      .filter((ref) => ref !== null);

    if (refs.length !== statement.evidenceIds.length) {
      issues.push(
        issue("semantic", "statement cites evidence outside this generation", path),
      );
      return;
    }

    if (refs.every((ref) => ref.kind === "teaching_example")) {
      issues.push(
        issue(
          "semantic",
          "statement rests only on a teaching example",
          path,
        ),
      );
    }
  });

  return issues;
}

/**
 * Applies the deterministic downgrade. `code_fact` conclusions are deleted;
 * authored rationale is downgraded to analysis; analysis is relabelled as
 * explicit speculation. The original strength is never preserved.
 */
function applyDowngrade(lesson: AnyLesson, ctx: ValidationContext): AnyLesson {
  const unsupported = new Set(
    unsupportedStatements(lesson, ctx).map((entry) => entry.path ?? ""),
  );

  const statements = lesson.statements.flatMap((statement, index) => {
    if (!unsupported.has(`statements.${index}`)) return [statement];

    if (statement.label === "code_fact") {
      return [];
    }
    if (statement.label === "recorded_design_rationale") {
      return [
        {
          ...statement,
          label: "engineering_analysis" as const,
          text: `推测：${statement.text}`,
        },
      ];
    }
    return [{ ...statement, text: `推测：${statement.text}` }];
  });

  return { ...lesson, statements };
}

function hasPath(issue: ValidationIssue, prefix: string): boolean {
  return (issue.path ?? "").startsWith(prefix);
}

/**
 * Runs the semantic gate. It calls the repair function at most once, then
 * falls back to a downgrade and re-evaluates. `checks.semantic` is `pass` only
 * when no unsupported statement remains.
 */
export async function validateSemantic(
  lesson: AnyLesson,
  ctx: ValidationContext,
  repair: SemanticRepairFn,
): Promise<{ lesson: AnyLesson; result: ValidationResult }> {
  let current = lesson;
  let issues = unsupportedStatements(current, ctx);

  if (issues.length === 0) {
    return { lesson: current, result: { ok: true, issues: [] } };
  }

  let repaired: AnyLesson;
  try {
    repaired = await repair({
      lesson: current as Lesson,
      issues,
      catalog: [],
    });
  } catch {
    // A failed repair is not a second chance: fall through to the downgrade.
    repaired = current;
  }
  current = repaired;

  issues = unsupportedStatements(current, ctx);
  if (issues.length > 0) {
    current = applyDowngrade(current, ctx);
    issues = unsupportedStatements(current, ctx);
  }

  // Anything still unsupported (for example a malformed repaired statement)
  // fails the semantic check rather than publishing at full strength.
  const remaining = issues.filter((entry) => hasPath(entry, "statements."));
  return {
    lesson: current,
    result:
      remaining.length === 0
        ? { ok: true, issues: [] }
        : { ok: false, issues: remaining },
  };
}
