/**
 * Markdown export and round-trip (architecture §9.7, AC-LES-16).
 *
 * The export is a human-readable document, but it also records the two sets a
 * round-trip must preserve: the mechanism ids taught by the two layers and the
 * evidence ids the lesson cites. `parseMarkdownBack` reads those sets back
 * without needing the original `Lesson` object.
 */

import type { SourceId, SourceRef } from "../contracts/index.js";
import type { AnyLesson } from "./schema.js";

const MECHANISM_LINE = /^\s*-\s+mechanismId:\s*(\S+)\s*$/u;
const EVIDENCE_LINE = /^\s*-\s+\[([A-Za-z0-9_-]+)\]\s*(.*)$/u;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function allEvidenceIds(lesson: AnyLesson): SourceId[] {
  const ids: string[] = [...lesson.evidence];

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
  }

  return sortedUnique(ids) as SourceId[];
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function labelFor(ref: SourceRef | undefined): string {
  if (ref === undefined) return "(unregistered)";
  if (ref.kind === "repo") {
    return ref.lines === null
      ? `${ref.path}@${ref.commitSha.slice(0, 12)}`
      : `${ref.path}:${ref.lines.start}-${ref.lines.end}@${ref.commitSha.slice(0, 12)}`;
  }
  if (ref.kind === "external") {
    return `${ref.title} — ${ref.canonicalUrl}`;
  }
  return ref.label;
}

/**
 * Renders a lesson as Markdown. Every mechanism id is emitted on its own
 * `mechanismId:` line and every evidence id on an `[id]` bullet, which is what
 * `parseMarkdownBack` reconstructs.
 */
export function lessonToMarkdown(lesson: AnyLesson, refs: SourceRef[]): string {
  const byId = new Map(refs.map((ref) => [ref.sourceId, ref]));
  const lines: string[] = [];

  lines.push(`# ${oneLine(lesson.scenario.userAction)}`);
  lines.push("");
  lines.push(`- lessonId: ${lesson.lessonId}`);
  lines.push(`- generationId: ${lesson.generationId}`);
  lines.push(`- kind: ${lesson.kind}`);
  lines.push(`- commitSha: ${lesson.context.commitSha}`);
  lines.push(`- scenario: ${lesson.scenario.kind}`);
  lines.push("");

  lines.push("## Contents");
  lines.push("");
  for (const module of lesson.overview) {
    lines.push(`- ${oneLine(module.moduleId)}: ${oneLine(module.responsibility)}`);
  }
  lines.push("");

  lines.push("## Plain explanation");
  lines.push("");
  for (const entry of lesson.plainExplanation) {
    lines.push(`- mechanismId: ${entry.mechanismId}`);
    lines.push(`  ${oneLine(entry.text)}`);
  }
  lines.push("");

  lines.push("## Technical explanation");
  lines.push("");
  for (const entry of lesson.technicalExplanation) {
    lines.push(`- mechanismId: ${entry.mechanismId}`);
    lines.push(`  ${oneLine(entry.text)}`);
  }
  lines.push("");

  lines.push("## Choices");
  lines.push("");
  if (lesson.choices.length === 0) {
    lines.push(`- ${oneLine(lesson.choicesOmittedReason ?? "no choices")}`);
  } else {
    for (const choice of lesson.choices) {
      lines.push(`- ${oneLine(choice.decision)} (current: ${oneLine(choice.current)})`);
      for (const alternative of choice.alternatives) {
        lines.push(
          `  - ${oneLine(alternative.option)}; fits: ${oneLine(
            alternative.whenItFits,
          )}; cost: ${oneLine(alternative.cost)}`,
        );
      }
    }
  }
  lines.push("");

  lines.push("## Boundaries");
  lines.push("");
  for (const boundary of lesson.boundaries) {
    lines.push(
      `- ${oneLine(boundary.item)} [${boundary.status}]: ${oneLine(boundary.limits)}`,
    );
  }
  lines.push("");

  lines.push("## Statements");
  lines.push("");
  for (const statement of lesson.statements) {
    lines.push(`- [${statement.label}] ${oneLine(statement.text)}`);
  }
  lines.push("");

  if (lesson.kind === "change") {
    lines.push("## Change");
    lines.push("");
    lines.push(
      `- before: ${oneLine(lesson.behaviorChange.before)}`,
    );
    lines.push(`- after: ${oneLine(lesson.behaviorChange.after)}`);
    lines.push("");
  }

  if (lesson.kind === "comparison") {
    lines.push("## Comparison");
    lines.push("");
    lines.push(`- base: ${lesson.context.comparison.base.commitSha}`);
    lines.push(`- head: ${lesson.context.comparison.head.commitSha}`);
    lines.push("");
  }

  lines.push("## Diagram");
  lines.push("");
  lines.push("```mermaid");
  lines.push(lesson.diagram.mermaid);
  lines.push("```");
  lines.push("");

  if (lesson.coverageGaps.length > 0) {
    lines.push("## Coverage gaps");
    lines.push("");
    for (const gap of lesson.coverageGaps) {
      lines.push(`- ${oneLine(gap)}`);
    }
    lines.push("");
  }

  lines.push("## Evidence");
  lines.push("");
  for (const sourceId of allEvidenceIds(lesson)) {
    lines.push(`- [${sourceId}] ${oneLine(labelFor(byId.get(sourceId)))}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Reads the preserved sets back. Sorting makes the result order-independent;
 * duplicates collapse, because the contract is about *sets*.
 */
export function parseMarkdownBack(markdown: string): {
  mechanismIds: string[];
  evidenceIds: SourceId[];
} {
  const mechanismIds: string[] = [];
  const evidenceIds: string[] = [];
  let inEvidenceSection = false;

  for (const line of markdown.split(/\r?\n/u)) {
    if (/^##\s+/u.test(line)) {
      inEvidenceSection = /^##\s+Evidence\s*$/iu.test(line);
    }

    const mechanism = MECHANISM_LINE.exec(line);
    if (mechanism !== null) {
      mechanismIds.push(mechanism[1]);
    }

    if (inEvidenceSection) {
      const evidence = EVIDENCE_LINE.exec(line);
      if (evidence !== null) {
        evidenceIds.push(evidence[1]);
      }
    }
  }

  return {
    mechanismIds: sortedUnique(mechanismIds),
    evidenceIds: sortedUnique(evidenceIds) as SourceId[],
  };
}
