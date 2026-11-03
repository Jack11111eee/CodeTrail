/**
 * Source-tagged conversation summaries (architecture §11.2, PRD §9).
 *
 * A summary replaces the dialogue that no longer fits the context budget. It is
 * never a source of code facts: every line that came from an assistant turn
 * carries the citations that turn used, and the summary's `sources` list is the
 * union of those ids. `cancelled` and `failed` messages never enter a summary
 * (AC-QA-06, AC-QA-15) — otherwise a crash or a disconnect could promote a
 * half-written answer into "facts".
 */

import type {
  ConversationSummary,
  MessageRecord,
  SourceId,
} from "../contracts/index.js";

/** How much summary text may replace dropped dialogue. */
export const DEFAULT_SUMMARY_MAX_CHARS = 600;

/** The only messages allowed into history or a summary. */
export function isHistoryEligible(message: MessageRecord): boolean {
  return message.status !== "cancelled" && message.status !== "failed";
}

function oneLine(text: string, max = 160): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function sourceTags(message: MessageRecord): SourceId[] {
  const seen = new Set<SourceId>();
  const ids: SourceId[] = [];
  for (const citation of message.citations) {
    if (seen.has(citation.sourceId)) continue;
    seen.add(citation.sourceId);
    ids.push(citation.sourceId);
  }
  return ids;
}

function answeredBy(next: MessageRecord | undefined): boolean {
  return (
    next !== undefined &&
    next.role === "assistant" &&
    next.unknownReason === null &&
    !next.incomplete
  );
}

/**
 * Builds the source-tagged summary and the unresolved questions for `messages`.
 *
 * `messages` must be the oldest-first history. Callers pass the messages that
 * did not fit the budget; `eligible` filtering is applied here so a cancelled
 * or failed message can never leak in through a caller's mistake.
 */
export function summarizeMessages(
  messages: readonly MessageRecord[],
  opts?: { maxChars?: number },
): ConversationSummary {
  const eligible = messages.filter(isHistoryEligible);
  const sources: SourceId[] = [];
  const seen = new Set<SourceId>();
  const lines: string[] = [];
  const unresolved: string[] = [];

  for (let index = 0; index < eligible.length; index += 1) {
    const message = eligible[index];
    const tags = sourceTags(message);
    for (const sourceId of tags) {
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      sources.push(sourceId);
    }
    const tagText = tags.length === 0 ? "" : ` [来源: ${tags.join(", ")}]`;

    if (message.role === "user") {
      lines.push(`用户：${oneLine(message.content)}${tagText}`);
      if (!answeredBy(eligible[index + 1])) {
        unresolved.push(oneLine(message.content, 120));
      }
    } else {
      const suffix = message.unknownReason === null ? "" : "（未确定）";
      lines.push(`助手：${oneLine(message.content)}${tagText}${suffix}`);
    }
  }

  let text = lines.join("\n");
  const maxChars = Math.max(0, Math.trunc(opts?.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS));
  if (text.length > maxChars) {
    // Keep the most recent dialogue: it is the part a learner is still using.
    text = `…${text.slice(text.length - Math.max(0, maxChars - 1))}`;
  }

  return { text, sources, unresolved };
}

/** The section body for a summary: text plus the unresolved questions. */
export function summarySectionText(summary: ConversationSummary): string {
  const parts: string[] = [];
  if (summary.text !== "") parts.push(summary.text);
  if (summary.unresolved.length > 0) {
    parts.push(`未解问题：${summary.unresolved.join("；")}`);
  }
  return parts.join("\n");
}
