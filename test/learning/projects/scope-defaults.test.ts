import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  MAX_FILES,
} from "../../../src/learning/config/defaults.ts";
import type { ExclusionReason } from "../../../src/learning/contracts/index.ts";
import {
  classifyPath,
  isReadable,
  languageOf,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import { blob, reportForFixture } from "./scope-fixtures.ts";

/**
 * AC-PRJ-09: the default tables keep secrets, dependency/build directories,
 * binaries, model weights, raw data and oversized files out of the generation
 * input, and every excluded path is accounted for by a gap row.
 */

interface Case {
  path: string;
  bytes: number;
  isDir: boolean;
  reason: ExclusionReason | null;
}

const DEFAULT_CASES: Case[] = [
  // dependency / build directories are excluded at any depth
  {
    path: "node_modules",
    bytes: 0,
    isDir: true,
    reason: "excluded_default_dir",
  },
  { path: "dist", bytes: 0, isDir: true, reason: "excluded_default_dir" },
  { path: "build", bytes: 0, isDir: true, reason: "excluded_default_dir" },
  { path: "out", bytes: 0, isDir: true, reason: "excluded_default_dir" },
  { path: ".venv", bytes: 0, isDir: true, reason: "excluded_default_dir" },
  {
    path: "__pycache__",
    bytes: 0,
    isDir: true,
    reason: "excluded_default_dir",
  },
  { path: ".turbo", bytes: 0, isDir: true, reason: "excluded_default_dir" },
  {
    path: "node_modules/left-pad/index.js",
    bytes: 60,
    isDir: false,
    reason: "excluded_default_dir",
  },
  {
    path: "packages/app/dist/bundle.js",
    bytes: 20,
    isDir: false,
    reason: "excluded_default_dir",
  },
  // secrets
  { path: ".env", bytes: 40, isDir: false, reason: "excluded_secret" },
  {
    path: ".env.production",
    bytes: 40,
    isDir: false,
    reason: "excluded_secret",
  },
  {
    path: "config/credentials.json",
    bytes: 40,
    isDir: false,
    reason: "excluded_secret",
  },
  {
    path: "deploy/server.pem",
    bytes: 40,
    isDir: false,
    reason: "excluded_secret",
  },
  { path: "keys/id_rsa", bytes: 40, isDir: false, reason: "excluded_secret" },
  // binaries and model weights
  { path: "model.bin", bytes: 40, isDir: false, reason: "excluded_binary" },
  {
    path: "weights/model.pt",
    bytes: 40,
    isDir: false,
    reason: "excluded_binary",
  },
  {
    path: "weights/model.safetensors",
    bytes: 40,
    isDir: false,
    reason: "excluded_binary",
  },
  { path: "lib/native.so", bytes: 40, isDir: false, reason: "excluded_binary" },
  {
    path: "images/logo.png",
    bytes: 40,
    isDir: false,
    reason: "excluded_binary",
  },
  // raw data
  {
    path: "data/table.parquet",
    bytes: 40,
    isDir: false,
    reason: "excluded_data",
  },
  {
    path: "state/app.sqlite",
    bytes: 40,
    isDir: false,
    reason: "excluded_data",
  },
  // deliberately kept
  { path: "data/table.csv", bytes: 40, isDir: false, reason: null },
  { path: "src/app.py", bytes: 40, isDir: false, reason: null },
  { path: "src/Main.java", bytes: 40, isDir: false, reason: null },
  { path: "README.md", bytes: 40, isDir: false, reason: null },
  { path: ".gitmodules", bytes: 40, isDir: false, reason: null },
  { path: "assets/model.lfs", bytes: 40, isDir: false, reason: null },
];

describe("classifyPath default tables", () => {
  const scope = normalizeScope();

  it.each(DEFAULT_CASES)(
    "$path ⇒ $reason",
    ({ path, bytes, isDir, reason }) => {
      expect(classifyPath(path, bytes, scope, isDir)).toBe(reason);
    },
  );

  it("keeps isReadable consistent with the table", () => {
    for (const { path, isDir, reason } of DEFAULT_CASES) {
      if (isDir) continue;
      // isReadable has no byte count, so size is the only reason it cannot see.
      const expected = reason === null || reason === "excluded_too_large";
      expect(isReadable(path, scope), path).toBe(expected);
    }
  });

  it("gives secrets, binaries and data precedence over size", () => {
    const oversized = 50 * 1024 * 1024;
    expect(classifyPath(".env", oversized, scope, false)).toBe(
      "excluded_secret",
    );
    expect(classifyPath("model.bin", oversized, scope, false)).toBe(
      "excluded_binary",
    );
    expect(classifyPath("data/table.parquet", oversized, scope, false)).toBe(
      "excluded_data",
    );
    expect(classifyPath("README.md", oversized, scope, false)).toBe(
      "excluded_too_large",
    );
  });

  it("excludes exactly at the size boundary only when larger", () => {
    const boundary = normalizeScope({ maxFileBytes: 100 });
    expect(classifyPath("src/app.py", 100, boundary, false)).toBeNull();
    expect(classifyPath("src/app.py", 101, boundary, false)).toBe(
      "excluded_too_large",
    );
  });

  it("applies a caller include/exclude after the default tables", () => {
    const custom = normalizeScope({
      include: ["src/**"],
      exclude: ["src/**/*.test.py"],
    });
    expect(classifyPath("src/app.py", 10, custom, false)).toBeNull();
    expect(classifyPath("src/app.test.py", 10, custom, false)).toBe(
      "excluded_by_scope",
    );
    expect(classifyPath("README.md", 10, custom, false)).toBe(
      "excluded_by_scope",
    );
  });
});

describe("normalizeScope defaults and determinism", () => {
  it("applies the frozen defaults", () => {
    const scope = normalizeScope();
    expect(scope.include).toEqual(["**/*"]);
    expect(scope.exclude).toEqual([]);
    expect(scope.maxFiles).toBe(MAX_FILES);
    expect(scope.maxFileBytes).toBe(MAX_FILE_BYTES);
    expect(scope.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("sorts and deduplicates patterns without changing the hash", () => {
    const left = normalizeScope({
      include: ["src/**", "./src/**", "lib/**"],
      exclude: ["docs/**", "docs/**"],
    });
    const right = normalizeScope({
      include: ["lib/**", "src/**"],
      exclude: ["docs/**"],
    });
    expect(left.include).toEqual(["lib/**", "src/**"]);
    expect(left.exclude).toEqual(["docs/**"]);
    expect(left.hash).toBe(right.hash);
    expect(normalizeScope().hash).toBe(normalizeScope().hash);
  });

  it("keeps explicitly empty arrays instead of substituting defaults", () => {
    const scope = normalizeScope({ include: [], exclude: [] });
    expect(scope.include).toEqual([]);
    expect(scope.exclude).toEqual([]);
  });
});

describe("scope-hygiene is fully accounted for (AC-PRJ-09)", () => {
  it("classifies every committed byte without dropping a path", async () => {
    const scope = normalizeScope();
    const { entries, report } = await reportForFixture("scope-hygiene", scope);

    const analyzed = new Set(report.analyzed.map((entry) => entry.path));
    const gaps = new Map(report.gaps.map((gap) => [gap.path, gap]));

    // Every committed path is either analysed or a gap — no silent drops.
    for (const entry of entries) {
      expect(
        analyzed.has(entry.path) || gaps.has(entry.path),
        `${entry.path} must be reported`,
      ).toBe(true);
    }

    for (const gap of report.gaps) {
      expect(gap.path, "gap path").toBeTruthy();
      expect(gap.reason, `gap reason for ${gap.path}`).toBeTruthy();
      expect(typeof gap.bytes, `gap bytes for ${gap.path}`).toBe("number");
      expect(gap.bytes).toBeGreaterThanOrEqual(0);
    }

    // Every excluded path from the fixture has a gap row and no analysed row.
    for (const excluded of [
      ".env",
      "node_modules/left-pad/index.js",
      "node_modules/left-pad/package.json",
      "dist/bundle.js",
      "model.bin",
      "weights/model.pt",
      "weights/model.safetensors",
    ]) {
      expect(analyzed.has(excluded), `${excluded} must not be analysed`).toBe(
        false,
      );
      expect(gaps.has(excluded), `${excluded} must have a gap row`).toBe(true);
    }

    // The only real source file survives.
    expect(analyzed.has("src/app.py")).toBe(true);

    // Nothing that passed classification is missing from the report.
    for (const entry of report.analyzed) {
      expect(classifyPath(entry.path, entry.bytes, scope, false)).toBeNull();
    }
  });

  it("reports oversized files as gaps rather than dropping them", async () => {
    const scope = normalizeScope({ maxFileBytes: 20 });
    const { report } = await reportForFixture("scope-hygiene", scope);
    const readme = report.gaps.find((gap) => gap.path === "README.md");
    expect(readme?.reason).toBe("excluded_too_large");
    expect(report.analyzed.some((entry) => entry.path === "README.md")).toBe(
      false,
    );
  });

  it("never reads an excluded file while building the report", async () => {
    const { readCalls } = await reportForFixture(
      "scope-hygiene",
      normalizeScope(),
    );
    for (const secret of [
      ".env",
      "node_modules/left-pad/index.js",
      "dist/bundle.js",
      "model.bin",
      "weights/model.pt",
      "weights/model.safetensors",
    ]) {
      expect(readCalls, `${secret} must not be read`).not.toContain(secret);
    }
  });

  it("labels preferred and non-preferred languages", () => {
    expect(languageOf("python/main.py")).toBe("python");
    expect(languageOf("java/Main.java")).toBe("java");
    expect(languageOf("ts/app.ts")).toBe("typescript");
    expect(languageOf("vue/App.vue")).toBe("vue");
    expect(languageOf("go/main.go")).toBe("go");
  });
});

describe("synthetic scope edges", () => {
  it("excludes everything when include is empty", async () => {
    const { report } = await reportForFixture(
      "scope-hygiene",
      normalizeScope({ include: [] }),
    );
    expect(report.analyzed).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.gaps.length).toBeGreaterThan(0);
  });

  it("keeps the blob helper shape compatible with TreeEntry", () => {
    expect(blob("src/app.py")).toMatchObject({
      path: "src/app.py",
      mode: "100644",
      type: "blob",
    });
  });
});
