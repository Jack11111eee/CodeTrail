/**
 * The frozen Chinese ↔ English term table (architecture §10.1, AC-RET-01).
 *
 * The table is deliberately small and stable: retrieval expands a learner's
 * Chinese question into the English vocabulary and identifiers a generated
 * wiki is likely to use. Tests index `TERM_ALIASES` directly, so the order and
 * contents are part of the contract.
 *
 * Lookup is bidirectional: a Chinese phrase and its English/symbol forms both
 * resolve to the same `TermAlias`. The table is never mutated at runtime.
 */

import type { TermId } from "../contracts/index.js";

export interface TermAlias {
  id: TermId;
  zh: string[];
  en: string[];
  symbols: string[];
}

function termId(value: string): TermId {
  return value as TermId;
}

export const TERM_ALIASES: readonly TermAlias[] = [
  {
    id: termId("t_snapshot"),
    zh: ["旧快照", "快照", "快照淘汰", "老快照"],
    en: ["snapshot", "evict", "eviction", "evicted", "cache"],
    symbols: ["SnapshotCache", "evict"],
  },
  {
    id: termId("t_schema"),
    zh: ["结构校验", "数据契约", "模式校验", "数据模型"],
    en: ["schema", "validation", "validator", "contract", "pydantic"],
    symbols: ["Pydantic", "BaseModel", "schema"],
  },
  {
    id: termId("t_change"),
    zh: ["变更学习", "更新收件箱", "变更记录"],
    en: ["change event", "inbox", "change record"],
    symbols: [],
  },
  {
    id: termId("t_version"),
    zh: ["固定版本", "快照版本", "版本固定"],
    en: ["commit", "snapshot", "pin", "revision"],
    symbols: ["commitSha"],
  },
  {
    id: termId("t_workflow"),
    zh: ["调用链", "请求往返"],
    en: ["call chain", "request flow", "sequence"],
    symbols: [],
  },
  {
    id: termId("t_boundary"),
    zh: ["边界", "已实现", "规划中"],
    en: ["boundary", "implemented", "planned"],
    symbols: [],
  },
];

function looksLikeSymbol(token: string): boolean {
  return /[A-Z_./*-]/u.test(token);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Case-insensitive whole-token match. `_`, `/`, `.` and `-` are boundaries, so
 * `snapshot_cache` reaches `cache` while `snapshotcache` does not reach
 * `snapshot` (the PascalCase symbol matches that query instead).
 */
function mentionsToken(lowerQuery: string, term: string): boolean {
  const pattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}([^a-z0-9]|$)`,
    "u",
  );
  return pattern.test(lowerQuery);
}

/**
 * Returns every alias the query mentions, in table order.
 *
 * Chinese phrases match as substrings (`旧快照` implies `快照`); English terms
 * and symbols match case-insensitively at token boundaries.
 */
export function lookupTerms(query: string): TermAlias[] {
  const lower = query.toLowerCase();
  return TERM_ALIASES.filter((alias) => {
    if (alias.zh.some((phrase) => query.includes(phrase))) return true;
    return [...alias.en, ...alias.symbols].some((term) =>
      mentionsToken(lower, term),
    );
  });
}

/**
 * Copies one alias' vocabulary. A defensive copy: callers (and tests) may
 * mutate the result without changing the frozen table.
 */
export function aliasesForTerm(id: TermId): {
  zh: string[];
  en: string[];
  symbols: string[];
} {
  const alias = TERM_ALIASES.find((entry) => entry.id === id);
  if (alias === undefined) {
    return { zh: [], en: [], symbols: [] };
  }
  return {
    zh: [...alias.zh],
    en: [...alias.en],
    symbols: [...alias.symbols],
  };
}

/** True when a token carries identifier/path shape rather than prose. */
export function isSymbolToken(token: string): boolean {
  return looksLikeSymbol(token);
}
