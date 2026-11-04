import { describe, expect, it } from "vitest";

import type { TermId } from "../../../src/learning/contracts/index.js";
import {
  TERM_ALIASES,
  aliasesForTerm,
  lookupTerms,
} from "../../../src/learning/qa/term-aliases.js";

/**
 * AC-RET-01: the frozen table maps 旧快照/快照淘汰 to SnapshotCache/evict and
 * 结构校验/数据契约 to schema/validation/Pydantic, and lookup works in both
 * directions.
 */

function idOf(value: string): TermId {
  return value as TermId;
}

describe("TERM_ALIASES", () => {
  it("is the six-entry frozen table from the architecture", () => {
    expect(TERM_ALIASES).toHaveLength(6);
    expect(TERM_ALIASES.map((alias) => alias.id)).toEqual([
      idOf("t_snapshot"),
      idOf("t_schema"),
      idOf("t_change"),
      idOf("t_version"),
      idOf("t_workflow"),
      idOf("t_boundary"),
    ]);
    for (const alias of TERM_ALIASES) {
      expect(alias.zh.length, `${alias.id} zh`).toBeGreaterThan(0);
      expect(alias.en.length, `${alias.id} en`).toBeGreaterThan(0);
    }
  });

  it("carries the snapshot vocabulary in both languages", () => {
    const [snapshot] = TERM_ALIASES;
    expect(snapshot?.zh).toEqual(["旧快照", "快照", "快照淘汰", "老快照"]);
    expect(snapshot?.en).toEqual([
      "snapshot",
      "evict",
      "eviction",
      "evicted",
      "cache",
    ]);
    expect(snapshot?.symbols).toEqual(["SnapshotCache", "evict"]);
  });
});

describe("lookupTerms", () => {
  it("maps every Chinese snapshot phrase to t_snapshot", () => {
    for (const phrase of ["旧快照", "快照", "快照淘汰", "老快照"]) {
      expect(lookupTerms(phrase).map((alias) => alias.id), phrase).toEqual([
        idOf("t_snapshot"),
      ]);
    }
  });

  it("maps English and symbol forms back to the same alias", () => {
    for (const phrase of ["snapshot", "evict", "eviction", "cache", "SnapshotCache"]) {
      expect(lookupTerms(phrase).map((alias) => alias.id), phrase).toContain(
        idOf("t_snapshot"),
      );
    }
    expect(lookupTerms("SnapshotCache").map((alias) => alias.id)).toEqual([
      idOf("t_snapshot"),
    ]);
  });

  it("maps 结构校验/数据契约 to t_schema, including Pydantic", () => {
    for (const phrase of ["结构校验", "数据契约", "模式校验", "数据模型"]) {
      expect(lookupTerms(phrase).map((alias) => alias.id), phrase).toEqual([
        idOf("t_schema"),
      ]);
    }
    for (const phrase of ["schema", "validation", "validator", "Pydantic"]) {
      expect(lookupTerms(phrase).map((alias) => alias.id), phrase).toContain(
        idOf("t_schema"),
      );
    }
  });

  it("returns every mentioned alias in table order", () => {
    expect(lookupTerms("旧快照和结构校验").map((alias) => alias.id)).toEqual([
      idOf("t_snapshot"),
      idOf("t_schema"),
    ]);
  });

  it("returns [] for a query with no known term", () => {
    expect(lookupTerms("量子纠缠")).toEqual([]);
    expect(lookupTerms("")).toEqual([]);
  });

  it("does not match an English term inside a longer identifier", () => {
    // `snapshotcache` is the symbol `SnapshotCache`, not the word `snapshot`.
    expect(lookupTerms("SnapshotCache").map((alias) => alias.id)).not.toContain(
      idOf("t_version"),
    );
  });
});

describe("aliasesForTerm", () => {
  it("returns a defensive copy of the vocabulary", () => {
    const first = aliasesForTerm(idOf("t_snapshot"));
    expect(first.symbols).toEqual(["SnapshotCache", "evict"]);
    first.zh.push("mutated");
    first.en.push("mutated");
    first.symbols.push("mutated");

    expect(aliasesForTerm(idOf("t_snapshot"))).toEqual({
      zh: ["旧快照", "快照", "快照淘汰", "老快照"],
      en: ["snapshot", "evict", "eviction", "evicted", "cache"],
      symbols: ["SnapshotCache", "evict"],
    });
    expect(TERM_ALIASES[0]?.zh).not.toContain("mutated");
  });

  it("returns empty arrays for an unknown id", () => {
    expect(aliasesForTerm(idOf("t_unknown"))).toEqual({
      zh: [],
      en: [],
      symbols: [],
    });
  });
});
