import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Provenance checker contract (AC-FORK-01..04).
 *
 * Every assertion here is a spawn of `scripts/check-provenance.mjs` (or of
 * `scripts/git-askpass.mjs`) against a temp copy of the recorded tree: the exit
 * code is the verdict, exactly as `pnpm run provenance:check` will use it. The
 * tests only use node builtins so they run before the learning test harness
 * (`test/learning/setup/**`) exists.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHECKER = path.join(REPO_ROOT, "scripts", "check-provenance.mjs");
const ASKPASS = path.join(REPO_ROOT, "scripts", "git-askpass.mjs");
const MANIFEST_FILE = "UPSTREAM_BASE.json";
const PINNED_COMMIT = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";
const UPSTREAM_REPO = "https://github.com/langchain-ai/openwiki";

const REQUIRED_MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.client.json",
];

const EXPECTED_ALLOWED_MODIFICATIONS = [
  "src/ingestion/code-mode.ts",
  "src/generation/repository-run.ts",
  "src/agent/repository-runner.ts",
  "package.json",
  // The server project's learning include/exclude split (architecture 18.2).
  "tsconfig.json",
  "tsconfig.client.json",
  "README.md",
  "src/visualize/page.ts",
  "src/visualize/styles.css",
  ".gitignore",
  // The generated fixture tree must stay outside test discovery and linting.
  "vitest.config.ts",
  "eslint.config.js",
  // Host-authored progress fields for the learning UI, with their coverage.
  "src/agent/types.ts",
  "test/agent/repository-runner.test.ts",
  "test/generation/repository-run.test.ts",
];

interface Manifest {
  upstream: { repo: string; commit: string; packageVersion: string; license: string };
  generatedAt: string;
  files: Record<string, string>;
  allowedModifications: { path: string; reason: string; addedExports?: string[] }[];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd: options.cwd ?? REPO_ROOT,
        env: { ...process.env, ...options.env },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function checkProvenance(args: string[]): Promise<RunResult> {
  return runScript(CHECKER, args);
}

function readManifest(root = REPO_ROOT): Manifest {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), "utf8")) as Manifest;
}

function sha256Of(absolutePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")}`;
}

/**
 * Copy the bytes the checker looks at — every recorded path plus the manifest,
 * the provenance doc and the license — so a test never drags `node_modules/` or
 * `.git/` into a temp directory.
 */
function copyRecordedTree(source: string, destination: string): void {
  const manifest = readManifest(source);
  const relatives = new Set([
    ...Object.keys(manifest.files),
    MANIFEST_FILE,
    "docs/provenance.md",
    "LICENSE",
  ]);

  for (const rel of relatives) {
    const from = path.join(source, rel);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    const to = path.join(destination, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function writeSyntheticFile(root: string, rel: string, contents: string | Buffer): string {
  const absolutePath = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return sha256Of(absolutePath);
}

/**
 * A manifest over a hand-built tree: proves the checker hashes raw bytes
 * (binary, CRLF, unicode) rather than re-encoded text, without depending on any
 * particular upstream file.
 */
function makeSyntheticRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-provenance-synthetic-"));
  const files: Record<string, string> = {};
  files["package.json"] = writeSyntheticFile(root, "package.json", '{"name":"synthetic","version":"0.0.0"}\n');
  files["pnpm-lock.yaml"] = writeSyntheticFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  files["pnpm-workspace.yaml"] = writeSyntheticFile(root, "pnpm-workspace.yaml", "minimumReleaseAge: 10080\n");
  files["tsconfig.json"] = writeSyntheticFile(root, "tsconfig.json", "{}\n");
  files["src/binary.dat"] = writeSyntheticFile(root, "src/binary.dat", Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]));
  files["src/crlf.txt"] = writeSyntheticFile(root, "src/crlf.txt", "line one\r\nline two\r\n");
  files["src/unicode.txt"] = writeSyntheticFile(root, "src/unicode.txt", "中文 — ✓\n");
  files["test/example.test.ts"] = writeSyntheticFile(root, "test/example.test.ts", "export {};\n");
  files["scripts/example.mjs"] = writeSyntheticFile(root, "scripts/example.mjs", "export {};\n");

  const manifest = {
    upstream: {
      repo: "https://example.invalid/synthetic",
      commit: "0".repeat(40),
      packageVersion: "0.0.0",
      license: "MIT",
    },
    generatedAt: new Date(0).toISOString(),
    files,
    allowedModifications: [],
  };
  fs.writeFileSync(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

let tempDirs: string[] = [];

function makeCopyOfRecordedTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-provenance-test-"));
  copyRecordedTree(REPO_ROOT, root);
  return root;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("UPSTREAM_BASE.json", () => {
  it("records the pinned upstream revision, version and license", () => {
    const manifest = readManifest();

    expect(manifest.upstream.commit).toBe(PINNED_COMMIT);
    expect(manifest.upstream.repo).toBe(UPSTREAM_REPO);
    expect(manifest.upstream.packageVersion).toBe("0.7.2");
    expect(manifest.upstream.license).toBe("MIT");
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records a sha256 for every required upstream file group", () => {
    const manifest = readManifest();
    const paths = Object.keys(manifest.files);

    expect(paths.length).toBeGreaterThanOrEqual(586);
    for (const digest of Object.values(manifest.files)) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    for (const required of REQUIRED_MANIFEST_FILES) {
      expect(manifest.files[required]).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(paths.some((rel) => rel.startsWith("src/"))).toBe(true);
    expect(paths.some((rel) => rel.startsWith("test/"))).toBe(true);
    expect(paths.some((rel) => rel.startsWith("scripts/"))).toBe(true);
    expect(paths.some((rel) => /^tsconfig[^/]*\.json$/.test(rel))).toBe(true);
  });

  it("pins the runtime to a version that satisfies the upstream engine range", () => {
    const pinned = fs.readFileSync(path.join(REPO_ROOT, ".node-version"), "utf8").trim();

    expect(pinned).toMatch(/^24\.13\.0$/);
    const [major, minor] = pinned.split(".").map(Number);
    expect(major > 22 || (major === 22 && minor >= 22)).toBe(true);
  });
});

describe("default check", () => {
  it("passes against the working tree", async () => {
    const result = await checkProvenance([]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("passes on an untouched copy of the recorded tree via --root", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);

    const result = await checkProvenance(["--root", root]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("fails with unexpected_modification when a non-allowlisted upstream file is rewritten", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    fs.appendFileSync(path.join(root, "src/retrieval/wiki.ts"), "\n// tampered\n");

    const result = await checkProvenance(["--root", root]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unexpected_modification");
    expect(result.stderr).toContain("src/retrieval/wiki.ts");
  });

  it("fails when a recorded file is deleted", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    fs.rmSync(path.join(root, "src/version.ts"));

    const result = await checkProvenance(["--root", root]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unexpected_modification");
    expect(result.stderr).toContain("src/version.ts (deleted)");
  });

  it("does not flag fork files that the manifest does not record", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "src/learning"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/learning/example.ts"), "export const added = true;\n");
    fs.writeFileSync(path.join(root, "docs/extra.md"), "# not upstream\n");

    const result = await checkProvenance(["--root", root]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("tolerates a modification to an allowlisted path", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    fs.appendFileSync(path.join(root, "src/visualize/styles.css"), '\n[data-testid="learning-entry"] { color: inherit; }\n');

    const result = await checkProvenance(["--root", root]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("fails with manifest_incomplete when the manifest is missing", async () => {
    const root = makeTempDir("codetrail-provenance-empty-");
    tempDirs.push(root);

    const result = await checkProvenance(["--root", root]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("manifest_incomplete");
    expect(result.stderr).toContain(MANIFEST_FILE);
  });

  it("hashes raw bytes, so binary, CRLF and unicode files round-trip", async () => {
    const root = makeSyntheticRoot();
    tempDirs.push(root);

    const clean = await checkProvenance(["--root", root]);
    expect(clean.stderr).toBe("");
    expect(clean.code).toBe(0);

    fs.writeFileSync(path.join(root, "src/crlf.txt"), "line one\nline two\n");
    const rewritten = await checkProvenance(["--root", root]);

    expect(rewritten.code).toBe(1);
    expect(rewritten.stderr).toContain("unexpected_modification");
    expect(rewritten.stderr).toContain("src/crlf.txt");
  });
});

describe("--report", () => {
  it("prints counts and the bounded modification allowlist with a reason per entry", async () => {
    const result = await checkProvenance(["--report"]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      counts: { manifestFiles: number; allowedModifications: number; unexpected: number; missing: number };
      allowedModifications: { path: string; reason: string }[];
    };

    expect(report.counts.manifestFiles).toBeGreaterThanOrEqual(586);
    expect(report.counts.unexpected).toBe(0);
    expect(report.counts.missing).toBe(0);
    expect(report.allowedModifications.length).toBeGreaterThan(0);
    expect(report.allowedModifications.length).toBeLessThanOrEqual(15);
    expect(report.allowedModifications.map((entry) => entry.path).sort()).toEqual(
      [...EXPECTED_ALLOWED_MODIFICATIONS].sort(),
    );
    for (const entry of report.allowedModifications) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
    expect(report.allowedModifications.some((entry) => entry.path === "src/ingestion/code-mode.ts")).toBe(true);
    expect(report.allowedModifications.some((entry) => entry.path.startsWith("src/visualize/"))).toBe(true);
  });
});

describe("--self-test", () => {
  it("rejects a copy with a rewritten non-allowlisted file while the untouched copy passes", async () => {
    const result = await checkProvenance(["--self-test"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("src/retrieval/wiki.ts");
    expect(result.stdout).toContain("unexpected_modification");
  });
});

describe("--license", () => {
  it("accepts the MIT text, the upstream copyright line and the provenance doc", async () => {
    const result = await checkProvenance(["--license"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MIT");
    expect(result.stdout).toContain(PINNED_COMMIT);
  });

  it("fails with license_missing when the MIT permission text is dropped", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    const licensePath = path.join(root, "LICENSE");
    const stripped = fs
      .readFileSync(licensePath, "utf8")
      .replace("Permission is hereby granted, free of charge", "Permission is withheld");
    fs.writeFileSync(licensePath, stripped);

    const result = await checkProvenance(["--root", root, "--license"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("license_missing");
    expect(result.stderr).toContain("LICENSE");
  });

  it("fails with provenance_doc_missing when the doc no longer names the commit", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    const docPath = path.join(root, "docs/provenance.md");
    fs.writeFileSync(docPath, fs.readFileSync(docPath, "utf8").split(PINNED_COMMIT).join("0".repeat(40)));

    const result = await checkProvenance(["--root", root, "--license"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("provenance_doc_missing");
    expect(result.stderr).toContain(PINNED_COMMIT);
  });

  it("fails with provenance_doc_missing when the doc is deleted", async () => {
    const root = makeCopyOfRecordedTree();
    tempDirs.push(root);
    fs.rmSync(path.join(root, "docs/provenance.md"));

    const result = await checkProvenance(["--root", root, "--license"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("provenance_doc_missing");
  });
});

describe("scripts/git-askpass.mjs", () => {
  const prompt = "Password for 'https://github.com':";

  it("prints the token and a newline, ignoring the prompt", async () => {
    const result = await runScript(ASKPASS, [prompt], { env: { CODETRAIL_GIT_TOKEN: "s3cret-token" } });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("s3cret-token\n");
    expect(result.stderr).toBe("");
  });

  it("exits 1 printing nothing when the token is unset", async () => {
    const result = await runScript(ASKPASS, [prompt], { env: { CODETRAIL_GIT_TOKEN: "" } });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
