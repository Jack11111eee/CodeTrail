import { describe, expect, it } from "vitest";

import { expandQuery } from "../../../src/learning/qa/query-expand.js";

/**
 * AC-RET-02: expansion maps Chinese vocabulary while copying identifiers and
 * paths verbatim — case untouched, never translated.
 */

describe("expandQuery", () => {
  it("keeps SnapshotCache and a source path exactly as written", () => {
    const expanded = expandQuery(
      "旧快照 SnapshotCache src/lmp/state/snapshot_cache.py 为什么",
    );

    expect(expanded.original).toBe(
      "旧快照 SnapshotCache src/lmp/state/snapshot_cache.py 为什么",
    );
    expect(expanded.terms).toContain("SnapshotCache");
    expect(expanded.terms).toContain("src/lmp/state/snapshot_cache.py");
    expect(expanded.terms).not.toContain("snapshotcache");
    expect(expanded.terms).not.toContain("snapshot_cache.py");
    expect(expanded.symbolPreserved).toContain("SnapshotCache");
    expect(expanded.symbolPreserved).toContain(
      "src/lmp/state/snapshot_cache.py",
    );
  });

  it("maps 旧快照/快照淘汰 to the snapshot vocabulary", () => {
    for (const query of ["旧快照", "快照淘汰"]) {
      const { terms } = expandQuery(query);
      expect(terms, query).toContain("SnapshotCache");
      expect(terms, query).toContain("evict");
      expect(terms, query).toContain("snapshot");
      expect(terms, query).toContain("cache");
    }
  });

  it("maps 结构校验/数据契约 to schema, validation and Pydantic", () => {
    for (const query of ["结构校验", "数据契约"]) {
      const { terms } = expandQuery(query);
      expect(terms, query).toContain("schema");
      expect(terms, query).toContain("validation");
      expect(terms, query).toContain("Pydantic");
    }
  });

  it("passes unmapped Chinese through unchanged", () => {
    const { terms } = expandQuery("量子纠缠");
    expect(terms).toEqual(["量子纠缠"]);
  });

  it("keeps the unmapped remainder of a partially mapped question", () => {
    const { terms } = expandQuery("旧快照丢了为什么会这样");
    expect(terms).toContain("SnapshotCache");
    expect(terms).toContain("丢了为什么会这样");
    expect(terms.some((term) => term.includes("旧快照"))).toBe(false);
  });

  it("preserves glob-shaped paths whole", () => {
    const { terms, symbolPreserved } = expandQuery("look at src/x/*.py");
    expect(terms).toContain("src/x/*.py");
    expect(symbolPreserved).toContain("src/x/*.py");
  });

  it("preserves a symbol-only query", () => {
    const expanded = expandQuery("SnapshotCache");
    expect(expanded.terms[0]).toBe("SnapshotCache");
    expect(expanded.symbolPreserved).toEqual(["SnapshotCache"]);
  });

  it("never lowercases or translates a code symbol", () => {
    const { terms } = expandQuery("SnapshotCache evict");
    expect(terms[0]).toBe("SnapshotCache");
    expect(terms[1]).toBe("evict");
    expect(terms).not.toContain("snapshotcache");
  });

  it("honours maxTerms without dropping the symbol first", () => {
    const expanded = expandQuery("旧快照 SnapshotCache", { maxTerms: 2 });
    expect(expanded.terms).toHaveLength(2);
    expect(expanded.terms[0]).toBe("SnapshotCache");
  });

  it("returns empty terms for an empty query", () => {
    expect(expandQuery("   ")).toEqual({
      original: "   ",
      terms: [],
      symbolPreserved: [],
    });
  });

  it("de-duplicates repeated terms case-insensitively", () => {
    const { terms } = expandQuery("SnapshotCache SnapshotCache snapshot");
    expect(terms.filter((term) => term === "SnapshotCache")).toHaveLength(1);
    expect(terms.filter((term) => term.toLowerCase() === "snapshot")).toHaveLength(
      1,
    );
  });
});
