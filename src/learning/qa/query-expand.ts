/**
 * Chinese-aware query expansion (architecture §10.2, AC-RET-02).
 *
 * A learner may ask in Chinese while the generated wiki is written in English
 * and quotes code identifiers. Expansion bridges that gap without ever
 * rewriting code: identifiers, `snake_case`/`camelCase`/`PascalCase` names and
 * paths are copied verbatim into `terms`, and only Chinese phrases are mapped
 * through `TERM_ALIASES`. Unmapped Chinese passes through unchanged — the
 * Chinese term will not match FTS5, which is exactly what triggers the
 * snapshot source fallback in §10.3/§10.4.
 */

import { isSymbolToken, lookupTerms } from "./term-aliases.js";

export interface ExpandedQuery {
  original: string;
  terms: string[];
  symbolPreserved: string[];
}

/**
 * Latin tokens, identifiers and paths. The character class intentionally adds
 * `*` to the architecture's `[A-Za-z_][\w.\/-]*` so glob-shaped paths such as
 * `src/x/*.py` survive whole. Nothing here is lowercased or translated.
 */
const LATIN_TOKEN = /[A-Za-z_][\w./*-]*/gu;

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;

const DEFAULT_MAX_TERMS = 32;

function clampMaxTerms(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TERMS;
  return Math.max(0, Math.trunc(value));
}

function uniquePreservingCase(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** Case-insensitive de-duplication that keeps the first spelling seen. */
function appendUnique(
  target: string[],
  seen: Set<string>,
  value: string,
): void {
  const key = value.toLowerCase();
  if (value === "" || seen.has(key)) return;
  seen.add(key);
  target.push(value);
}

/**
 * Removes every matched Chinese alias phrase from a CJK run. Longer phrases
 * are removed first so `快照淘汰` does not leave a stray `淘汰` behind.
 */
function stripAliasPhrases(run: string, phrases: readonly string[]): string {
  let residual = run;
  for (const phrase of [...phrases].sort((left, right) => right.length - left.length)) {
    residual = residual.split(phrase).join("\u0000");
  }
  return residual;
}

/**
 * Expands a query into FTS-friendly terms.
 *
 * Ordering is meaningful: verbatim code tokens come first (so a `maxTerms`
 * cap can never drop an identifier), then alias vocabulary (symbols before
 * English words), then unmapped Chinese.
 */
export function expandQuery(
  query: string,
  opts?: { maxTerms?: number },
): ExpandedQuery {
  const original = query;
  if (query.trim() === "") {
    return { original, terms: [], symbolPreserved: [] };
  }

  const latinTokens = uniquePreservingCase(query.match(LATIN_TOKEN) ?? []);
  const symbolPreserved = latinTokens.filter(isSymbolToken);

  const aliases = lookupTerms(query);
  const seen = new Set<string>(latinTokens.map((token) => token.toLowerCase()));
  const terms: string[] = [...latinTokens];

  for (const alias of aliases) {
    for (const symbol of alias.symbols) {
      appendUnique(terms, seen, symbol);
    }
    for (const english of alias.en) {
      appendUnique(terms, seen, english);
    }
  }

  const aliasPhrases = aliases.flatMap((alias) => alias.zh);
  const unmapped: string[] = [];
  for (const run of query.match(CJK_RUN) ?? []) {
    const residual = stripAliasPhrases(run, aliasPhrases);
    for (const chunk of residual.split("\u0000")) {
      const trimmed = chunk.trim();
      if (trimmed !== "") unmapped.push(trimmed);
    }
  }
  for (const chunk of uniquePreservingCase(unmapped)) {
    appendUnique(terms, seen, chunk);
  }

  return {
    original,
    terms: terms.slice(0, clampMaxTerms(opts?.maxTerms)),
    symbolPreserved,
  };
}
