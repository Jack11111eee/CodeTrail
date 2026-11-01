import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The imported upstream tree (AC-FORK-01).
 *
 * The fork vendored `langchain-ai/openwiki` at a single pinned commit
 * byte-identically; `UPSTREAM_BASE.json` is the record of that import. These
 * assertions check the import itself: the upstream test suite is present in
 * full, every recorded path is on disk with its recorded digest, and the
 * upstream package identity that the upstream tests depend on is untouched.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MANIFEST_FILE = "UPSTREAM_BASE.json";
const PINNED_COMMIT = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";

const UPSTREAM_DIRECTORIES = [
  ".changeset",
  ".github",
  "evals",
  "examples",
  "integrations",
  "openwiki",
  "scripts",
  "skills",
  "src",
  "static",
  "test",
];

const UPSTREAM_ROOT_FILES = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "DEVELOPMENT.md",
  "LICENSE",
  "README.md",
  "eslint.config.js",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.client.json",
  "tsconfig.eslint.json",
  "tsconfig.json",
  "vitest.config.ts",
];

/** Fork-owned files that must never appear in the upstream record. */
const FORK_ONLY_FILES = [
  "UPSTREAM_BASE.json",
  "docs/provenance.md",
  "scripts/check-provenance.mjs",
  "scripts/git-askpass.mjs",
  ".node-version",
];

interface Manifest {
  upstream: { repo: string; commit: string; packageVersion: string; license: string };
  files: Record<string, string>;
  allowedModifications: { path: string; reason: string }[];
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MANIFEST_FILE), "utf8")) as Manifest;
}

function sha256Of(absolutePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")}`;
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(absolutePath));
    } else if (entry.isFile()) {
      found.push(absolutePath);
    }
  }
  return found;
}

describe("upstream tree", () => {
  it("ships at least 200 upstream test files under test/", () => {
    const testFiles = walk(path.join(REPO_ROOT, "test"))
      .map((absolutePath) => path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"))
      .filter((rel) => rel.startsWith("test/") && !rel.startsWith("test/learning/"))
      .filter((rel) => rel.endsWith(".test.ts") || rel.endsWith(".test.tsx"));

    expect(testFiles.length).toBeGreaterThanOrEqual(200);
  });

  it("keeps the upstream top-level layout", () => {
    for (const directory of UPSTREAM_DIRECTORIES) {
      const absolutePath = path.join(REPO_ROOT, directory);
      expect(fs.existsSync(absolutePath), `${directory}/ is missing`).toBe(true);
      expect(fs.statSync(absolutePath).isDirectory(), `${directory} is not a directory`).toBe(true);
    }
    for (const file of UPSTREAM_ROOT_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `${file} is missing`).toBe(true);
    }
  });

  it("records every upstream file and nothing the fork added", () => {
    const manifest = readManifest();
    const recorded = Object.keys(manifest.files);

    expect(manifest.upstream.commit).toBe(PINNED_COMMIT);
    expect(recorded.length).toBeGreaterThanOrEqual(586);
    for (const forkOnly of FORK_ONLY_FILES) {
      expect(recorded, `${forkOnly} must not be recorded as upstream`).not.toContain(forkOnly);
    }
    expect(recorded.some((rel) => rel.startsWith("test/learning/"))).toBe(false);
    expect(recorded.some((rel) => rel.startsWith("docs/"))).toBe(false);
  });

  it("has every recorded path on disk with its recorded sha256", () => {
    const manifest = readManifest();
    const allowed = new Set(manifest.allowedModifications.map((entry) => entry.path));
    const mismatched: string[] = [];
    const missing: string[] = [];

    for (const [rel, expected] of Object.entries(manifest.files)) {
      const absolutePath = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(absolutePath)) {
        missing.push(rel);
        continue;
      }
      if (allowed.has(rel)) continue;
      if (sha256Of(absolutePath) !== expected) mismatched.push(rel);
    }

    expect(missing).toEqual([]);
    expect(mismatched).toEqual([]);
  });

  it("leaves LICENSE byte-identical to the pinned upstream blob", () => {
    const manifest = readManifest();

    expect(sha256Of(path.join(REPO_ROOT, "LICENSE"))).toBe(manifest.files.LICENSE);
  });

  it("keeps the upstream package identity that upstream tests assert", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license: string;
      engines: { node: string };
      packageManager: string;
      keywords: string[];
      pi: unknown;
    };

    expect(pkg.name).toBe("openwiki");
    expect(pkg.version).toBe("0.7.2");
    expect(pkg.license).toBe("MIT");
    expect(pkg.engines.node).toBe(">=22.22.0");
    expect(pkg.packageManager).toBe("pnpm@11.25.0");
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi).toBeDefined();
  });
});
