#!/usr/bin/env node
/**
 * Provenance checker for the pinned upstream tree.
 *
 * The repository is a fork of `langchain-ai/openwiki` at a single pinned commit.
 * `UPSTREAM_BASE.json` records the sha256 of every file that commit tracks plus
 * the closed list of paths this fork is allowed to modify. This script is the
 * only thing that decides whether that claim still holds, so it must be able to
 * run before `pnpm install` ever happens: it is dependency-free ESM and imports
 * nothing but `node:` builtins.
 *
 *   node scripts/check-provenance.mjs [--root <dir>] [--report] [--self-test] [--license]
 *
 * Modes (exit 0 = pass, 1 = fail; failures are reported on stderr with a
 * machine-readable code):
 *   (default)    every recorded file exists and hashes to its recorded digest,
 *                except for paths listed in `allowedModifications`
 *   --report     the default check plus a JSON summary on stdout:
 *                `{counts, allowedModifications:[{path,reason,addedExports?}]}`
 *   --self-test  proves the check can actually fail: copy the recorded tree to a
 *                temp dir, assert the untouched copy passes, rewrite
 *                `src/retrieval/wiki.ts` (not allowlisted) and assert the copy
 *                then fails with `unexpected_modification` naming that path
 *   --license    `LICENSE` still carries the MIT text and the upstream copyright
 *                line, and `docs/provenance.md` names the pinned commit and repo
 *
 * `--root <dir>` re-roots the whole check, so tests and the self-test can run
 * against a temp copy instead of the working tree.
 *
 * Failure codes: `unexpected_modification`, `manifest_incomplete`,
 * `license_missing`, `provenance_doc_missing`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MANIFEST_FILE = "UPSTREAM_BASE.json";
const LICENSE_FILE = "LICENSE";
const PROVENANCE_DOC = "docs/provenance.md";
const SELF_TEST_TARGET = "src/retrieval/wiki.ts";

const USAGE = `usage: node scripts/check-provenance.mjs [--root <dir>] [--report] [--self-test] [--license]
`;

/** Files the manifest must record by exact relative path. */
const REQUIRED_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
];

/** File groups the manifest must cover with at least one entry each. */
const REQUIRED_GROUPS = [
  { label: "src/**", matches: (rel) => rel.startsWith("src/") },
  { label: "test/**", matches: (rel) => rel.startsWith("test/") },
  { label: "scripts/**", matches: (rel) => rel.startsWith("scripts/") },
  { label: "tsconfig*.json", matches: (rel) => /^tsconfig[^/]*\.json$/.test(rel) },
];

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

const LICENSE_REQUIREMENTS = [
  { pattern: /^MIT License\s*$/m, label: "the 'MIT License' heading" },
  { pattern: /Permission is hereby granted, free of charge/, label: "the MIT permission grant" },
  { pattern: /THE SOFTWARE IS PROVIDED "AS IS"/, label: "the MIT warranty disclaimer" },
  { pattern: /Copyright \(c\) \d{4}/, label: "the upstream copyright line" },
];

function failure(code, detail) {
  return { code, detail };
}

function formatFailure(entry) {
  return `${entry.code} ${entry.detail}`;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    report: false,
    selfTest: false,
    license: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory");
      options.root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length);
      if (!value) throw new Error("--root requires a directory");
      options.root = path.resolve(value);
    } else if (arg === "--report") {
      options.report = true;
    } else if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--license") {
      options.license = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function loadManifest(root) {
  const file = path.join(root, MANIFEST_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { manifest: null, errors: [failure("manifest_incomplete", `${MANIFEST_FILE} is missing under ${root}`)] };
  }

  try {
    return { manifest: JSON.parse(raw), errors: [] };
  } catch (error) {
    return {
      manifest: null,
      errors: [failure("manifest_incomplete", `${MANIFEST_FILE} is not valid JSON: ${error.message}`)],
    };
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (path.isAbsolute(rel) || rel.includes("\\")) return false;
  return !rel.split("/").includes("..");
}

function validateManifest(manifest) {
  const errors = [];

  if (!isPlainObject(manifest)) {
    return [failure("manifest_incomplete", `${MANIFEST_FILE} is not a JSON object`)];
  }

  const upstream = isPlainObject(manifest.upstream) ? manifest.upstream : {};
  for (const key of ["repo", "commit", "packageVersion", "license"]) {
    if (typeof upstream[key] !== "string" || upstream[key].trim() === "") {
      errors.push(failure("manifest_incomplete", `upstream.${key} is missing`));
    }
  }
  if (typeof upstream.commit === "string" && !COMMIT_SHA.test(upstream.commit)) {
    errors.push(failure("manifest_incomplete", `upstream.commit is not a 40-character commit sha: ${upstream.commit}`));
  }
  if (typeof upstream.license === "string" && upstream.license !== "MIT") {
    errors.push(failure("manifest_incomplete", `upstream.license is not MIT: ${upstream.license}`));
  }

  if (!isPlainObject(manifest.files) || Object.keys(manifest.files).length === 0) {
    errors.push(failure("manifest_incomplete", "files is missing or empty"));
    return errors;
  }

  const recorded = Object.keys(manifest.files);
  for (const rel of recorded) {
    if (!isSafeRelativePath(rel)) {
      errors.push(failure("manifest_incomplete", `files has an unsafe path: ${rel}`));
    }
    if (!SHA256_DIGEST.test(String(manifest.files[rel]))) {
      errors.push(failure("manifest_incomplete", `files[${rel}] is not a sha256 digest`));
    }
  }

  for (const rel of REQUIRED_FILES) {
    if (!(rel in manifest.files)) {
      errors.push(failure("manifest_incomplete", `files does not record ${rel}`));
    }
  }

  for (const group of REQUIRED_GROUPS) {
    if (!recorded.some((rel) => group.matches(rel))) {
      errors.push(failure("manifest_incomplete", `files records no ${group.label} file`));
    }
  }

  if (!Array.isArray(manifest.allowedModifications)) {
    errors.push(failure("manifest_incomplete", "allowedModifications is missing"));
    return errors;
  }

  const seen = new Set();
  for (const entry of manifest.allowedModifications) {
    if (!isPlainObject(entry) || !isSafeRelativePath(entry.path)) {
      errors.push(failure("manifest_incomplete", "allowedModifications has an entry without a path"));
      continue;
    }
    if (seen.has(entry.path)) {
      errors.push(failure("manifest_incomplete", `allowedModifications lists ${entry.path} twice`));
    }
    seen.add(entry.path);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      errors.push(failure("manifest_incomplete", `allowedModifications[${entry.path}] has no reason`));
    }
  }

  return errors;
}

function sha256OfFile(absolutePath) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")}`;
}

/**
 * Hash every recorded file from its raw bytes (no newline translation, no
 * encoding step), and fail on any drift that the allowlist does not cover.
 * Deleting a recorded file always fails: the allowlist permits edits to an
 * upstream file, never its removal.
 */
function verifyFiles(root, manifest) {
  const allowed = new Set(manifest.allowedModifications.map((entry) => entry.path));
  const errors = [];
  const counts = {
    manifestFiles: Object.keys(manifest.files).length,
    allowedModifications: allowed.size,
    verified: 0,
    allowedChanged: 0,
    unexpected: 0,
    missing: 0,
  };

  for (const [rel, expected] of Object.entries(manifest.files)) {
    const absolutePath = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      counts.missing += 1;
      errors.push(failure("unexpected_modification", `${rel} (deleted)`));
      continue;
    }

    if (stat.isSymbolicLink()) {
      if (allowed.has(rel)) {
        counts.allowedChanged += 1;
      } else {
        counts.unexpected += 1;
        errors.push(failure("unexpected_modification", `${rel} (replaced by a symbolic link)`));
      }
      continue;
    }

    if (!stat.isFile()) {
      counts.unexpected += 1;
      errors.push(failure("unexpected_modification", `${rel} (no longer a regular file)`));
      continue;
    }

    let actual;
    try {
      actual = sha256OfFile(absolutePath);
    } catch (error) {
      counts.unexpected += 1;
      errors.push(failure("unexpected_modification", `${rel} (unreadable: ${error.message})`));
      continue;
    }

    if (actual === expected) {
      counts.verified += 1;
      continue;
    }

    if (allowed.has(rel)) {
      counts.allowedChanged += 1;
      continue;
    }

    counts.unexpected += 1;
    errors.push(failure("unexpected_modification", `${rel} (recorded ${expected}, found ${actual})`));
  }

  return { errors, counts };
}

function checkRoot(root) {
  const loaded = loadManifest(root);
  const errors = [...loaded.errors];
  if (loaded.manifest) errors.push(...validateManifest(loaded.manifest));

  if (loaded.manifest && errors.length === 0) {
    const verified = verifyFiles(root, loaded.manifest);
    errors.push(...verified.errors);
    return { manifest: loaded.manifest, errors, counts: verified.counts };
  }

  return { manifest: loaded.manifest, errors, counts: null };
}

function checkLicense(root, manifest) {
  const errors = [];

  let licenseText = null;
  try {
    licenseText = fs.readFileSync(path.join(root, LICENSE_FILE), "utf8");
  } catch {
    errors.push(failure("license_missing", `${LICENSE_FILE} is missing under ${root}`));
  }
  if (licenseText !== null) {
    for (const requirement of LICENSE_REQUIREMENTS) {
      if (!requirement.pattern.test(licenseText)) {
        errors.push(failure("license_missing", `${LICENSE_FILE} does not contain ${requirement.label}`));
      }
    }
  }

  const upstream = isPlainObject(manifest?.upstream) ? manifest.upstream : {};
  let doc = null;
  try {
    doc = fs.readFileSync(path.join(root, PROVENANCE_DOC), "utf8");
  } catch {
    errors.push(failure("provenance_doc_missing", `${PROVENANCE_DOC} is missing under ${root}`));
  }
  if (doc !== null) {
    if (typeof upstream.commit === "string" && !doc.includes(upstream.commit)) {
      errors.push(failure("provenance_doc_missing", `${PROVENANCE_DOC} does not name the upstream commit ${upstream.commit}`));
    }
    if (typeof upstream.repo === "string" && !doc.includes(upstream.repo)) {
      errors.push(failure("provenance_doc_missing", `${PROVENANCE_DOC} does not name the upstream repository ${upstream.repo}`));
    }
  }

  return errors;
}

/**
 * Copy exactly the bytes the check looks at (the recorded tree plus the
 * manifest and the provenance doc) into `destination`, so the self-test never
 * drags `node_modules/` or `.git/` along.
 */
function copyRecordedTree(root, destination) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), "utf8"));
  const relatives = new Set([...Object.keys(manifest.files), MANIFEST_FILE, PROVENANCE_DOC, LICENSE_FILE]);
  let copied = 0;

  for (const rel of relatives) {
    if (!isSafeRelativePath(rel)) continue;
    const from = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const to = path.join(destination, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
  }

  return copied;
}

function runSelfTest(root) {
  let destination;
  try {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-provenance-selftest-"));
  } catch (error) {
    return { ok: false, detail: `could not create a temp directory: ${error.message}` };
  }

  try {
    let copied;
    try {
      copied = copyRecordedTree(root, destination);
    } catch (error) {
      return { ok: false, detail: `could not copy the recorded tree: ${error.message}` };
    }

    const untouched = checkRoot(destination);
    if (untouched.errors.length > 0) {
      return {
        ok: false,
        detail: `the untouched copy did not pass: ${untouched.errors.map(formatFailure).join("; ")}`,
      };
    }

    const target = path.join(destination, SELF_TEST_TARGET);
    if (!fs.existsSync(target)) {
      return { ok: false, detail: `${SELF_TEST_TARGET} is not part of the recorded tree` };
    }
    fs.appendFileSync(target, "\n// codetrail provenance self-test mutation\n");

    const mutated = checkRoot(destination);
    const detected = mutated.errors.some(
      (entry) => entry.code === "unexpected_modification" && entry.detail.includes(SELF_TEST_TARGET),
    );
    if (!detected) {
      return {
        ok: false,
        detail: `rewriting ${SELF_TEST_TARGET} was not reported as unexpected_modification`,
      };
    }

    return { ok: true, copied };
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

function reportFailures(errors) {
  for (const entry of errors) {
    process.stderr.write(`${formatFailure(entry)}\n`);
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (options.selfTest) {
    const result = runSelfTest(options.root);
    if (!result.ok) {
      process.stderr.write(`unexpected_modification self-test failed: ${result.detail}\n`);
      return 1;
    }
    process.stdout.write(
      `provenance: self-test ok — rewriting ${SELF_TEST_TARGET} was reported as unexpected_modification; ` +
        `the untouched copy of ${result.copied} recorded files passed\n`,
    );
    return 0;
  }

  if (options.license) {
    const loaded = loadManifest(options.root);
    const errors = [...loaded.errors];
    if (loaded.manifest) errors.push(...validateManifest(loaded.manifest));
    errors.push(...checkLicense(options.root, loaded.manifest));

    if (errors.length > 0) {
      reportFailures(errors);
      return 1;
    }
    const upstream = loaded.manifest.upstream;
    process.stdout.write(
      `provenance: license ok — MIT text and the upstream copyright line are intact in ${LICENSE_FILE}; ` +
        `${PROVENANCE_DOC} names ${upstream.commit} (${upstream.repo})\n`,
    );
    return 0;
  }

  const checked = checkRoot(options.root);
  const errors = checked.errors;
  const counts = checked.counts ?? {
    manifestFiles: 0,
    allowedModifications: 0,
    verified: 0,
    allowedChanged: 0,
    unexpected: 0,
    missing: 0,
  };

  if (options.report) {
    const allowedModifications = (checked.manifest?.allowedModifications ?? []).map((entry) => {
      const projected = { path: entry.path, reason: entry.reason };
      if (Array.isArray(entry.addedExports) && entry.addedExports.length > 0) {
        projected.addedExports = entry.addedExports;
      }
      return projected;
    });
    process.stdout.write(`${JSON.stringify({ counts, allowedModifications }, null, 2)}\n`);
  }

  if (errors.length > 0) {
    reportFailures(errors);
    return 1;
  }

  if (!options.report) {
    process.stdout.write(
      `provenance: ok — ${counts.verified}/${counts.manifestFiles} recorded files match, ` +
        `${counts.allowedChanged} allowlisted modification(s) of ${counts.allowedModifications} allowed\n`,
    );
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
