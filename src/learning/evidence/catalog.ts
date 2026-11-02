/**
 * The prompt evidence catalog (architecture §8.3).
 *
 * The model may only cite ids it was given here. Each entry carries a
 * deterministic label and a trimmed excerpt; the combined excerpt length never
 * exceeds `budgetChars`. A ref whose content cannot be read is omitted rather
 * than padded with invented text.
 */

import type {
  EvidenceCatalogEntry,
  LanguageId,
  SourceReader,
  SourceRef,
} from "../contracts/index.js";
import { normalizeScope } from "../projects/scope.js";
import { languageOf } from "../projects/scope.js";

/** Longest excerpt handed to the model, in lines. */
export const MAX_CATALOG_LINES = 40;

export type { EvidenceCatalogEntry };

function labelOf(ref: SourceRef): string {
  if (ref.kind === "repo") {
    return ref.lines === null
      ? ref.path
      : `${ref.path}:${ref.lines.start}-${ref.lines.end}`;
  }
  if (ref.kind === "external") {
    return ref.locator === ""
      ? `${ref.title} — ${ref.canonicalUrl}`
      : `${ref.title} — ${ref.canonicalUrl} (${ref.locator})`;
  }
  return ref.label;
}

function languageOfRef(ref: SourceRef): LanguageId {
  return ref.kind === "repo" ? languageOf(ref.path) : "other";
}

function excerptOf(text: string): string {
  const lines = text.split(/\r?\n/u);
  return lines.slice(0, MAX_CATALOG_LINES).join("\n").trimEnd();
}

/**
 * Reads each ref through `reader` and builds the catalog. Reading is
 * best-effort: a ref that cannot be read is skipped, never fabricated.
 */
export async function buildCatalog(
  refs: SourceRef[],
  reader: SourceReader,
  budgetChars: number,
): Promise<EvidenceCatalogEntry[]> {
  const scope = normalizeScope();
  const limit = Math.max(0, Math.trunc(budgetChars));
  let remaining = limit;
  const entries: EvidenceCatalogEntry[] = [];

  for (const ref of refs) {
    let text: string;
    try {
      text =
        ref.kind === "repo"
          ? await reader.readRepo(ref, scope)
          : ref.kind === "external"
            ? await reader.readExternal(ref)
            : "";
    } catch {
      continue;
    }

    const full = excerptOf(text);
    const excerpt =
      full.length <= remaining ? full : full.slice(0, Math.max(0, remaining));
    remaining -= excerpt.length;

    entries.push({
      sourceId: ref.sourceId,
      label: labelOf(ref),
      excerpt,
      language: languageOfRef(ref),
    });
  }

  return entries;
}
