/**
 * Evidence validation (architecture §9.4, AC-LES-07/08).
 *
 * Two rules live here:
 *
 * - `evidence_repo`: a registered repo source must still resolve at its commit
 *   — the path exists, the line range is valid and the `content_hash` matches
 *   the exact slice. Registration validates the same facts, and this validator
 *   repeats the check so a lesson cannot be published against drifted content.
 * - `evidence_compare`: a comparison lesson's before/after sides must be
 *   independently versioned. Base- and head-side statements may not point at
 *   the other side, and the two side sets may not share a commit.
 *
 * Every cited id — anywhere in the lesson — must belong to this generation.
 * That is the mechanism that makes "no invented evidence" enforceable rather
 * than aspirational (architecture §8.3).
 */

import { sliceHash, sliceLines } from "../../contracts/index.js";
import type {
  SnapshotReader,
  SourceId,
  SourceRef,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from "../../contracts/index.js";
import type { AnyLesson } from "../schema.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return {
    code,
    message: path === undefined ? message : `${path}: ${message}`,
    ...(path === undefined ? {} : { path }),
  };
}

/** The evidence id → ref lookup, tolerant of a registry that has no bucket yet. */
export function safeGetRef(
  ctx: ValidationContext,
  sourceId: SourceId,
): SourceRef | null {
  try {
    return ctx.registry.get(ctx.generation.generationId, sourceId);
  } catch {
    return null;
  }
}

/** Picks the snapshot that owns a commit, or null when the commit is foreign. */
export function snapshotForCommit(
  ctx: ValidationContext,
  commitSha: string,
): SnapshotReader | null {
  if (ctx.snapshot.commitSha === commitSha) return ctx.snapshot;
  if (ctx.baseSnapshot !== null && ctx.baseSnapshot.commitSha === commitSha) {
    return ctx.baseSnapshot;
  }
  return null;
}

const DESIGN_DOC_PATTERN =
  /(?:design|decision|adr|rfc|architecture|rationale|proposal|specification|design-doc)/iu;

/**
 * True when a source is a design/decision document. A decision record lives in
 * the analysed repository (`docs/decisions/decision-log.md`,
 * `docs/design/*.md`) just as often as on an external page, so a repository
 * path participates in the same matrix. Used by the label/source matrix
 * (AC-LES-06) and by boundary status (AC-LES-05).
 */
export function isDesignDoc(ref: SourceRef): boolean {
  if (ref.kind === "repo") {
    return DESIGN_DOC_PATTERN.test(ref.path);
  }
  if (ref.kind !== "external") return false;
  return DESIGN_DOC_PATTERN.test(
    `${ref.title} ${ref.canonicalUrl} ${ref.locator}`,
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Every evidence id the lesson cites, wherever it appears. `lesson.evidence` is
 * the declared set; statements/choices/boundaries/diagram carry the per-claim
 * ids the validator must resolve.
 */
export function collectEvidenceIds(lesson: AnyLesson): SourceId[] {
  const ids: SourceId[] = [...lesson.evidence];

  for (const statement of lesson.statements) ids.push(...statement.evidenceIds);
  for (const choice of lesson.choices) {
    ids.push(...choice.evidenceIds);
    for (const alternative of choice.alternatives) {
      ids.push(...alternative.evidenceIds);
    }
  }
  for (const boundary of lesson.boundaries) ids.push(...boundary.evidenceIds);
  for (const node of lesson.diagram.nodes) ids.push(...node.evidenceIds);
  for (const edge of lesson.diagram.edges) ids.push(...edge.evidenceIds);

  if (lesson.kind === "change") {
    for (const alternative of lesson.alternatives) {
      ids.push(...alternative.evidenceIds);
    }
    ids.push(...lesson.evidence);
  }

  return sortedUnique(ids) as SourceId[];
}

interface RepoCheckOutcome {
  issues: ValidationIssue[];
}

async function validateRepoRef(
  ctx: ValidationContext,
  sourceId: SourceId,
  ref: Extract<SourceRef, { kind: "repo" }>,
): Promise<RepoCheckOutcome> {
  const issues: ValidationIssue[] = [];
  const path = `evidence.${sourceId}`;

  if (ref.commitSha.trim() === "") {
    issues.push(
      issue("evidence_repo", "repo source has no commit", path),
    );
    return { issues };
  }

  if (!ctx.allowedCommitShas.includes(ref.commitSha)) {
    issues.push(
      issue(
        ctx.mode === "comparison" ? "evidence_compare" : "evidence_repo",
        `commit ${ref.commitSha} does not belong to this generation`,
        path,
      ),
    );
    return { issues };
  }

  const snapshot = snapshotForCommit(ctx, ref.commitSha);
  if (snapshot === null) {
    issues.push(
      issue(
        "evidence_repo",
        `no snapshot is bound to commit ${ref.commitSha}`,
        path,
      ),
    );
    return { issues };
  }

  if (!(await snapshot.exists(ref.path))) {
    issues.push(
      issue("evidence_repo", `path ${ref.path} does not exist`, path),
    );
    return { issues };
  }

  let text: string;
  try {
    text = await snapshot.read(ref.path);
  } catch {
    issues.push(
      issue("evidence_repo", `path ${ref.path} could not be read`, path),
    );
    return { issues };
  }

  if (ref.lines !== null) {
    const { start, end } = ref.lines;
    const lineCount = text.split("\n").length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > lineCount
    ) {
      issues.push(
        issue(
          "evidence_repo",
          `line range ${start}-${end} is invalid for ${ref.path} (${lineCount} lines)`,
          path,
        ),
      );
      return { issues };
    }
  }

  const content = ref.lines === null ? text : sliceLines(text, ref.lines);
  if (sliceHash(content) !== ref.contentHash) {
    issues.push(
      issue(
        "evidence_repo",
        `content_hash does not match ${ref.path}`,
        path,
      ),
    );
  }

  return { issues };
}

function refCommit(ref: SourceRef): string | null {
  if (ref.kind === "repo") return ref.commitSha;
  if (ref.kind === "external") return ref.versionOrRetrievedAt;
  return null;
}

function validateCompareSides(
  lesson: AnyLesson,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (lesson.kind !== "comparison") {
    issues.push(
      issue(
        "evidence_compare",
        "comparison mode requires a comparison lesson",
        "kind",
      ),
    );
    return issues;
  }

  const comparison = lesson.context.comparison;
  if (comparison === undefined) {
    issues.push(
      issue(
        "evidence_compare",
        "context.comparison is required for a comparison lesson",
        "context.comparison",
      ),
    );
    return issues;
  }

  const baseCommit = comparison.base.commitSha;
  const headCommit = comparison.head.commitSha;
  if (baseCommit === headCommit) {
    issues.push(
      issue(
        "evidence_compare",
        "base and head must name different commits",
        "context.comparison",
      ),
    );
  }

  if (ctx.baseSnapshot === null) {
    issues.push(
      issue(
        "evidence_compare",
        "comparison mode requires a base snapshot",
        "context.comparison",
      ),
    );
  }

  const baseSet = new Set<string>();
  const headSet = new Set<string>();

  lesson.statements.forEach((statement, index) => {
    const path = `statements.${index}`;
    if (statement.side === undefined) {
      issues.push(
        issue("evidence_compare", "every statement needs a side", path),
      );
      return;
    }

    const refs = statement.evidenceIds
      .map((id) => safeGetRef(ctx, id))
      .filter((ref): ref is SourceRef => ref !== null);

    for (const ref of refs) {
      const commit = refCommit(ref);
      if (ref.kind === "external" && commit !== null && commit.trim() === "") {
        issues.push(
          issue(
            "evidence_compare",
            "external evidence needs a version or retrieval time",
            path,
          ),
        );
      }
      if (ref.kind !== "repo") continue;

      if (statement.side === "base" && ref.commitSha !== baseCommit) {
        issues.push(
          issue(
            "evidence_compare",
            `base statement cites a ${ref.commitSha} source`,
            path,
          ),
        );
      }
      if (statement.side === "head" && ref.commitSha !== headCommit) {
        issues.push(
          issue(
            "evidence_compare",
            `head statement cites a ${ref.commitSha} source`,
            path,
          ),
        );
      }
      if (statement.side === "base" && ref.commitSha === baseCommit) {
        baseSet.add(ref.commitSha);
      }
      if (statement.side === "head" && ref.commitSha === headCommit) {
        headSet.add(ref.commitSha);
      }
    }
  });

  for (const commit of baseSet) {
    if (headSet.has(commit)) {
      issues.push(
        issue(
          "evidence_compare",
          `base and head sides share commit ${commit}`,
          "statements",
        ),
      );
    }
  }

  return issues;
}

/**
 * Validates every evidence citation (AC-LES-07/08). Asynchronous because the
 * repository checks read the immutable snapshot at the cited commit.
 */
export async function validateEvidence(
  lesson: AnyLesson,
  ctx: ValidationContext,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  for (const sourceId of collectEvidenceIds(lesson)) {
    const ref = safeGetRef(ctx, sourceId);
    if (ref === null) {
      issues.push(
        issue(
          "evidence_repo",
          `evidence id ${sourceId} is not registered to this generation`,
          `evidence.${sourceId}`,
        ),
      );
      continue;
    }
    if (ref.kind === "repo") {
      const outcome = await validateRepoRef(ctx, sourceId, ref);
      issues.push(...outcome.issues);
    }
  }

  if (ctx.mode === "comparison") {
    issues.push(...validateCompareSides(lesson, ctx));
  }

  return { ok: issues.length === 0, issues };
}
