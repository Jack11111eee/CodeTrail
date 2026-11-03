#!/usr/bin/env node
/**
 * Dependency licence report (PRD §14, AC-OPS-06).
 *
 *   node scripts/licenses.mjs [--json]
 *
 * Emits `{packages:[{name, version, license}]}` sorted by package name. The
 * fork itself (`openwiki`) is always present with its declared `MIT`; a package
 * whose manifest carries no licence field is reported as `unknown` rather
 * than omitted, so the report never hides a licensing question.
 *
 * The package list comes from `pnpm-lock.yaml`; each licence is read from the
 * installed manifest (`node_modules`, including pnpm's virtual store).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const UNKNOWN = "unknown";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Opens the `packages:` block of a pnpm lockfile. */
function lockfileEntries(lockfile) {
  const entries = [];
  if (!fs.existsSync(lockfile)) return entries;
  const lines = fs.readFileSync(lockfile, "utf8").split(/\r?\n/u);
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/u.test(line) && !line.startsWith("#")) break;
    const match = /^ {2}(?:"|')?(.+?)(?:"|')?:\s*$/u.exec(line);
    if (match) entries.push(match[1]);
  }
  return entries;
}

/** Splits a lockfile key into `{name, version}` for both pnpm v6 and v9. */
export function parseLockfileKey(key) {
  const cleaned = key.trim().replace(/^(['"])(.*)\1$/u, "$2");
  if (cleaned.startsWith("/")) {
    const parts = cleaned.slice(1).split("/");
    const versionIndex = parts.findIndex((part) => /^\d/u.test(part));
    if (versionIndex > 0) {
      return {
        name: parts.slice(0, versionIndex).join("/"),
        version: parts.slice(versionIndex).join("/").replace(/\(.*$/u, ""),
      };
    }
    return null;
  }
  const at = cleaned.lastIndexOf("@");
  if (at <= 0) return null;
  return {
    name: cleaned.slice(0, at),
    version: cleaned.slice(at + 1).replace(/\(.*$/u, ""),
  };
}

function licenseField(manifest) {
  if (manifest === null) return null;
  const value = manifest.license;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value !== null && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  if (Array.isArray(manifest.licenses)) {
    const names = manifest.licenses
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof entry?.type === "string"
            ? entry.type
            : null,
      )
      .filter((entry) => typeof entry === "string" && entry !== "");
    if (names.length > 0) return names.join(" OR ");
  }
  return null;
}

function virtualStoreName(name) {
  return name.startsWith("@") ? name.replace("/", "+") : name;
}

/** Reads the installed manifest for `name@version`, if it is on disk. */
function installedManifest(root, name, version) {
  const direct = path.join(root, "node_modules", ...name.split("/"), "package.json");
  const found = readJson(direct);
  if (found !== null) return found;

  const store = path.join(root, "node_modules", ".pnpm");
  if (!fs.existsSync(store)) return null;
  const prefix = `${virtualStoreName(name)}@${version}`;
  let candidates;
  try {
    candidates = fs.readdirSync(store);
  } catch {
    return null;
  }
  for (const entry of candidates) {
    if (entry !== prefix && !entry.startsWith(`${prefix}(`)) continue;
    const manifest = readJson(
      path.join(store, entry, "node_modules", ...name.split("/"), "package.json"),
    );
    if (manifest !== null) return manifest;
  }
  return null;
}

/**
 * Collects the report.
 *
 * @param {{root?: string, lockfile?: string}} [options]
 * @returns {{packages: {name: string, version: string, license: string}[]}}
 */
export function collectLicenses(options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const lockfile = options.lockfile ?? path.join(root, "pnpm-lock.yaml");
  const manifest = readJson(path.join(root, "package.json")) ?? {};

  const byKey = new Map();
  const add = (name, version, license) => {
    if (typeof name !== "string" || name === "") return;
    const key = `${name}@${version ?? ""}`;
    if (byKey.has(key)) return;
    byKey.set(key, {
      name,
      version: String(version ?? ""),
      license: typeof license === "string" && license !== "" ? license : UNKNOWN,
    });
  };

  for (const key of lockfileEntries(lockfile)) {
    const parsed = parseLockfileKey(key);
    if (parsed === null) continue;
    const installed = installedManifest(root, parsed.name, parsed.version);
    add(parsed.name, parsed.version, licenseField(installed));
  }

  // The fork is the report's anchor requirement: it is not installed in its
  // own `node_modules`, so its licence comes from the root manifest.
  if (typeof manifest.name === "string" && manifest.name !== "") {
    add(manifest.name, manifest.version ?? "", licenseField(manifest));
  }

  const packages = [...byKey.values()].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) return byName;
    return left.version.localeCompare(right.version);
  });
  return { packages };
}

function parseArgs(argv) {
  const options = { json: false, root: REPO_ROOT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root needs a directory");
      options.root = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      options.root = path.resolve(argument.slice("--root=".length));
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--") continue;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write("usage: node scripts/licenses.mjs [--json] [--root <dir>]\n");
    return 0;
  }
  const report = collectLicenses({ root: options.root });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report)}\n`
      : `${JSON.stringify(report, null, 2)}\n`,
  );
  return 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
