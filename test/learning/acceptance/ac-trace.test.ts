/**
 * Acceptance traceability map (architecture Appendix A, the coverage rule after
 * A.15).
 *
 * The rule the map enforces is threefold:
 *
 *   (a) the registry *is* Appendix A: exactly 208 ids in 15 families, pinned by
 *       a sha256 of the sorted id list, so an id cannot be added or dropped
 *       silently;
 *   (b) every id resolves to an owner that exists — a test file, a `scripts/`
 *       entry or a `package.json` command;
 *   (c) no test file cites an id that the table does not define.
 *
 * The checker is proven non-vacuous by a self-test: an unknown id and a
 * registry entry whose owner file is absent both produce failures, so a green
 * run cannot mean "the map only lists what it happens to test".
 *
 * Owners that live in a sibling issue's files are declared in
 * `PENDING_OWNERS`; the moment the file exists it is asserted like any other
 * owner, so the list cannot outlive the file it names.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  AC_REGISTRY,
  APPENDIX_A_IDS_SHA256,
  FAMILY_COUNTS,
} from "./ac-registry.ts";

/**
 * Re-exported for the phase-D gate (`matrix:10`), which counts the ten flow
 * ids without re-reading the table.
 */
export { AC_REGISTRY };

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TEST_ROOT = path.join(REPO_ROOT, "test");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");

/** `pnpm` subcommands every checkout has without a `package.json` script. */
const PNPM_BUILTINS: ReadonlySet<string> = new Set(["install"]);

/**
 * Owners provided by a sibling issue's file. Each entry names the file the
 * registry expects and the issue that creates it; `auditRegistry` accepts the
 * id only while that file is still absent.
 *
 * The list is pinned below: it may not grow, and once the sibling issue lands
 * a file it is asserted like every other owner. In this isolated worktree
 * `issue-32-regression-updates` has not merged, so exactly these thirteen
 * files are absent.
 */
const SIBLING_OWNER_ISSUE = "issue-32-regression-updates";
const PENDING_IDS = [
  "AC-R04-01",
  "AC-R04-02",
  "AC-R10-01",
  "AC-R10-02",
  "AC-R11-01",
  "AC-R11-02",
  "AC-R12-01",
  "AC-R12-02",
  "AC-R13-01",
  "AC-R14-01",
  "AC-R14-02",
  "AC-R15-01",
  "AC-R15-02",
] as const;

export const PENDING_OWNERS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(PENDING_IDS.map((id) => [id, SIBLING_OWNER_ISSUE])),
);

const AC_ID = /AC-[A-Z0-9]+(?:-[A-Z0-9]+)*/gu;

function packageScripts(): Record<string, string> {
  return (
    JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
}

function exists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** True when a registry owner is present in this checkout. */
export function ownerExists(
  owner: string,
  kind: string,
  scripts: Record<string, string> = packageScripts(),
): boolean {
  if (kind !== "test" && kind !== "command") return false;
  if (owner.startsWith("pnpm:")) {
    const name = owner.slice("pnpm:".length);
    return name in scripts || PNPM_BUILTINS.has(name);
  }
  if (owner === "" || owner.includes(" ")) return false;
  return exists(path.join(REPO_ROOT, owner));
}

export interface RegistryProblem {
  id: string;
  reason: string;
}

/**
 * The whole coverage rule as a pure-ish function over a registry. Returns every
 * problem instead of failing on the first one, so a red run names all holes.
 */
export function auditRegistry(
  registry: Readonly<Record<string, { owner: string; kind: string }>>,
  options: {
    pending?: Readonly<Record<string, string>>;
    scripts?: Record<string, string>;
  } = {},
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const pending = options.pending ?? {};
  const scripts = options.scripts ?? packageScripts();

  for (const [id, entry] of Object.entries(registry)) {
    if (!/^AC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(id)) {
      problems.push({ id, reason: "malformed_id" });
      continue;
    }
    if (entry.owner.trim() === "") {
      problems.push({ id, reason: "unowned" });
      continue;
    }
    if (ownerExists(entry.owner, entry.kind, scripts)) continue;
    if (id in pending) continue;
    problems.push({ id, reason: `owner_missing:${entry.owner}` });
  }

  for (const id of Object.keys(pending)) {
    if (!(id in registry)) {
      problems.push({ id, reason: "pending_id_not_in_registry" });
    }
  }

  return problems;
}

function familyOf(id: string): string {
  if (id.startsWith("AC-GATE") || id.startsWith("AC-SCOPE"))
    return "GATE+SCOPE";
  if (/^AC-R\d/u.test(id)) return "R";
  if (/^AC-F\d\d/u.test(id)) return "F";
  return id.split("-")[1];
}

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(absolute, out);
    } else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) {
      out.push(absolute);
    }
  }
  return out;
}

describe("the registry is Appendix A", () => {
  test("208 ids in 15 families, pinned by an id-set hash", () => {
    const ids = Object.keys(AC_REGISTRY).sort();
    expect(ids).toHaveLength(208);
    expect(createHash("sha256").update(ids.join("\n")).digest("hex")).toBe(
      APPENDIX_A_IDS_SHA256,
    );

    const families = new Map<string, number>();
    for (const id of ids) {
      families.set(familyOf(id), (families.get(familyOf(id)) ?? 0) + 1);
    }
    expect(Object.fromEntries([...families].sort())).toEqual({
      ENV: 5,
      FORK: 8,
      PRJ: 17,
      GEN: 20,
      LES: 17,
      RET: 9,
      QA: 15,
      UPD: 27,
      API: 13,
      SEC: 12,
      UI: 11,
      OPS: 9,
      R: 27,
      F: 10,
      "GATE+SCOPE": 8,
    });
    expect(families.size).toBe(15);
    expect(Object.keys(FAMILY_COUNTS).sort()).toEqual(
      [...families.keys()].sort(),
    );
    for (const [family, count] of families) {
      expect(FAMILY_COUNTS[family]).toBe(count);
    }
  });

  test("every id names exactly one owner of a known kind", () => {
    for (const [id, entry] of Object.entries(AC_REGISTRY)) {
      expect(entry.kind, id).toMatch(/^(test|command)$/u);
      expect(entry.owner.trim(), id).not.toBe("");
      expect(entry.owner, id).not.toContain(" ");
    }
  });
});

describe("every id maps to an owner that exists", () => {
  test("the audit is clean", () => {
    expect(auditRegistry(AC_REGISTRY, { pending: PENDING_OWNERS })).toEqual([]);
  });

  test("pending owners are exactly the sibling issue's files and cannot hide a present owner", () => {
    // The escape hatch is closed: only these thirteen ids may defer, and only
    // while the sibling issue has not merged their files.
    expect(Object.keys(PENDING_OWNERS).sort()).toEqual([...PENDING_IDS].sort());
    for (const [id, issue] of Object.entries(PENDING_OWNERS)) {
      expect(issue, id).toBe(SIBLING_OWNER_ISSUE);
      const entry = AC_REGISTRY[id];
      expect(entry, id).toBeDefined();
      // Once the sibling file exists it is treated like every other owner: it
      // must cite the id, so the pending entry can never outlive the file.
      if (ownerExists(entry.owner, entry.kind)) {
        const body = fs.readFileSync(path.join(REPO_ROOT, entry.owner), "utf8");
        expect(body, id).toContain(id);
      }
    }
  });

  test("acceptance ids own the ten flow files", () => {
    const flows = Object.entries(AC_REGISTRY).filter(([id]) =>
      /^AC-F\d\d-01$/u.test(id),
    );
    expect(flows).toHaveLength(10);
    for (const [id, entry] of flows) {
      expect(entry.kind, id).toBe("test");
      expect(entry.owner, id).toMatch(
        /^test\/learning\/acceptance\/f\d\d-[a-z-]+\.test\.ts$/u,
      );
      expect(exists(path.join(REPO_ROOT, entry.owner)), id).toBe(true);
      const body = fs.readFileSync(path.join(REPO_ROOT, entry.owner), "utf8");
      expect(body, id).toContain(id);
    }
  });
});

describe("no test claims an id the table does not define", () => {
  test("every AC id cited under test/ resolves to a registry row", () => {
    const files = walk(TEST_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const unknown: { file: string; id: string }[] = [];
    for (const file of files) {
      // This file is the map itself: it names synthetic ids and family
      // prefixes on purpose, so it cannot be audited against its own table.
      if (file === path.join(import.meta.dirname, "ac-trace.test.ts")) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(AC_ID)) {
        if (!(match[0] in AC_REGISTRY)) {
          unknown.push({
            file: path.relative(REPO_ROOT, file),
            id: match[0],
          });
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("the checker itself cannot pass vacuously", () => {
  test("an unowned id, a malformed id and a missing owner all fail", () => {
    const problems = auditRegistry(
      {
        "AC-TEST-01": { owner: "", kind: "test" },
        "not-an-ac-id": { owner: "test/learning/nope.test.ts", kind: "test" },
        "AC-TEST-02": {
          owner: "test/learning/does-not-exist.test.ts",
          kind: "test",
        },
        "AC-TEST-03": { owner: "pnpm:no-such-script", kind: "command" },
        "AC-TEST-04": {
          owner: "test/learning/acceptance/ac-trace.test.ts",
          kind: "test",
        },
      },
      { pending: {}, scripts: {} },
    );
    expect(problems).toEqual([
      { id: "AC-TEST-01", reason: "unowned" },
      { id: "not-an-ac-id", reason: "malformed_id" },
      {
        id: "AC-TEST-02",
        reason: "owner_missing:test/learning/does-not-exist.test.ts",
      },
      { id: "AC-TEST-03", reason: "owner_missing:pnpm:no-such-script" },
    ]);
  });

  test("a pending id absent from the registry fails too", () => {
    const problems = auditRegistry(
      {},
      { pending: { "AC-GHOST-01": "issue-00" }, scripts: {} },
    );
    expect(problems).toEqual([
      { id: "AC-GHOST-01", reason: "pending_id_not_in_registry" },
    ]);
  });
});
