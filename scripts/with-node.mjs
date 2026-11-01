#!/usr/bin/env node
/**
 * Pinned-runtime launcher.
 *
 * Every JavaScript entry point in `package.json` runs through this file so it
 * executes under an interpreter that satisfies `engines.node` (`>=22.22.0`),
 * even when the ambient `node` on `PATH` is older. It never installs, switches
 * or writes any global Node configuration: it only reads probe paths, and it
 * augments the child's `PATH` so tools that shell out to `node` find the same
 * interpreter.
 *
 *   node scripts/with-node.mjs [--print-bin] [--require=<semver>] <script> [args...]
 *
 * Resolution order (first candidate that satisfies the requirement wins):
 *   1. `$CODETRAIL_NODE_BIN` (absolute path)
 *   2. the version pinned in `<repo>/.node-version`, probed in the usual
 *      version-manager install locations
 *   3. `node` on `PATH`
 *   4. otherwise exit 1 with `node_version_unsupported` on stderr
 *
 * `--print-bin` prints the resolved absolute path and exits 0 without spawning.
 * The child's exit code is propagated verbatim; if the child dies from a signal
 * the wrapper exits `128 + signum`.
 *
 * This file must stay runnable on any Node >= 16 (plain ESM, `node:` builtins
 * only) so it can bootstrap a too-old ambient interpreter. `check-env.mjs`
 * imports `resolveNode` from here, so the launcher and the environment report
 * can never disagree about which interpreter was chosen.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The range every resolved interpreter must satisfy. */
export const DEFAULT_REQUIREMENT = ">=22.22.0";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE = `usage: node scripts/with-node.mjs [--print-bin] [--require=<semver>] <script> [args...]
`;

const REQUIREMENT_PATTERN = /^(>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)$/;
const VERSION_OUTPUT_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * Raised when no candidate interpreter satisfies the requirement. The `code`
 * matches the string the acceptance harness greps for on stderr.
 */
export class NodeResolutionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "NodeResolutionError";
    this.code = "node_version_unsupported";
    this.requirement = details.requirement;
    this.pinnedVersion = details.pinnedVersion;
    this.probed = details.probed;
  }
}

/**
 * Parses `v24.13.0` / `24.13.0` (any trailing pre-release is ignored) into its
 * numeric parts.
 *
 * @param {unknown} text - Candidate version string.
 * @returns {{major: number, minor: number, patch: number, version: string}|null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = VERSION_OUTPUT_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    version: `${Number(major)}.${Number(minor)}.${Number(patch)}`,
  };
}

/**
 * Orders two parsed versions.
 *
 * @returns {number} Negative when `left` is older, positive when newer, 0 equal.
 */
export function compareVersions(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

/**
 * Tests a version against a `>=x.y.z`-style requirement. A bare version is
 * treated as an exact match.
 *
 * @param {string} version - Candidate version.
 * @param {string} [requirement] - Comparator plus version.
 */
export function satisfies(version, requirement = DEFAULT_REQUIREMENT) {
  const candidate = parseVersion(version);
  const match = REQUIREMENT_PATTERN.exec(String(requirement).trim());
  if (!candidate || !match) return false;
  const [, comparator = "=", major, minor, patch] = match;
  const target = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
  const order = compareVersions(candidate, target);
  switch (comparator) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    default:
      return order === 0;
  }
}

/** Reads the pinned version from `<root>/.node-version` (or `.nvmrc`). */
function readPinnedVersion(repoRoot) {
  for (const name of [".node-version", ".nvmrc"]) {
    const file = path.join(repoRoot, name);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const value = raw.split(/\r?\n/u)[0].trim();
    if (value !== "") return { value, source: name };
  }
  return null;
}

/** The candidate list, in resolution order. */
export function probeCandidates({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const candidates = [];
  const home = env.HOME || os.homedir();

  const configured = env.CODETRAIL_NODE_BIN;
  if (typeof configured === "string" && configured.trim() !== "") {
    candidates.push({ bin: path.resolve(configured.trim()), via: "CODETRAIL_NODE_BIN" });
  }

  const pinned = readPinnedVersion(repoRoot);
  if (pinned) {
    const parsed = parseVersion(pinned.value);
    const version = parsed ? parsed.version : pinned.value;
    const major = parsed ? String(parsed.major) : pinned.value;
    const voltaHome = env.VOLTA_HOME || path.join(home, ".volta");
    const templates = [
      ["nvm", path.join(home, ".nvm", "versions", "node", `v${version}`, "bin", "node")],
      [
        "fnm",
        path.join(
          home,
          ".local",
          "share",
          "fnm",
          "node-versions",
          `v${version}`,
          "installation",
          "bin",
          "node",
        ),
      ],
      ["volta", path.join(voltaHome, "tools", "image", "node", version, "bin", "node")],
      ["homebrew", path.join("/opt/homebrew/opt", `node@${major}`, "bin", "node")],
      ["homebrew", path.join("/usr/local/opt", `node@${major}`, "bin", "node")],
      ["versioned", path.join("/usr/local/bin", `node-${version}`)],
      ["versioned", path.join("/opt", `node-${version}`, "bin", "node")],
    ];
    for (const [via, bin] of templates) candidates.push({ bin, via });
  }

  const onPath = findOnPath("node", env);
  if (onPath) candidates.push({ bin: onPath, via: "PATH" });

  return candidates;
}

/** Resolves an executable name against the supplied `PATH`, without a shell. */
function findOnPath(name, env) {
  const entries = String(env.PATH || "").split(path.delimiter);
  const suffixes = process.platform === "win32" ? [".exe", ""] : [""];
  for (const entry of entries) {
    if (entry === "") continue;
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `${name}${suffix}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not in this directory; keep looking.
      }
    }
  }
  return null;
}

/** Version-checks one candidate, returning either the version or a reason. */
function inspectCandidate(bin, requirement) {
  let stat;
  try {
    stat = fs.statSync(bin);
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not a regular file" };

  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: "did not answer --version" };
  }
  const parsed = parseVersion(result.stdout);
  if (!parsed) return { ok: false, reason: "unparseable --version output" };
  if (!satisfies(parsed.version, requirement)) {
    return {
      ok: false,
      reason: `${parsed.version} does not satisfy ${requirement}`,
    };
  }
  return { ok: true, version: parsed.version };
}

/**
 * Resolves the interpreter every script must run under.
 *
 * @param {object} [options]
 * @param {string} [options.requirement] - Range the interpreter must satisfy.
 * @param {Record<string, string|undefined>} [options.env] - Environment to read.
 * @param {string} [options.repoRoot] - Directory holding `.node-version`.
 * @returns {{bin: string, version: string, via: string}}
 * @throws {NodeResolutionError} When no candidate satisfies the requirement.
 */
export function resolveNode({
  requirement = DEFAULT_REQUIREMENT,
  env = process.env,
  repoRoot = REPO_ROOT,
} = {}) {
  const probed = [];
  for (const candidate of probeCandidates({ env, repoRoot })) {
    const inspected = inspectCandidate(candidate.bin, requirement);
    if (inspected.ok) {
      return {
        bin: path.resolve(candidate.bin),
        version: inspected.version,
        via: candidate.via,
      };
    }
    probed.push({ ...candidate, reason: inspected.reason });
  }

  const pinned = readPinnedVersion(repoRoot);
  const lines = probed.map((entry) => `  - ${entry.via}: ${entry.bin} (${entry.reason})`);
  throw new NodeResolutionError(
    [
      `no Node interpreter satisfies ${requirement}`,
      `  .node-version: ${pinned ? pinned.value : "(missing)"}`,
      "  probed:",
      ...(lines.length > 0 ? lines : ["  - (no candidates)"]),
    ].join("\n"),
    { requirement, pinnedVersion: pinned ? pinned.value : null, probed },
  );
}

function parseArgs(argv) {
  const options = {
    printBin: false,
    requirement: DEFAULT_REQUIREMENT,
    help: false,
    script: null,
    scriptArgs: [],
  };

  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--print-bin") {
      options.printBin = true;
    } else if (arg === "--require") {
      const value = argv[index + 1];
      if (!value) throw new Error("--require needs a value");
      options.requirement = value;
      index += 1;
    } else if (arg.startsWith("--require=")) {
      options.requirement = arg.slice("--require=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--") {
      index += 1;
      break;
    } else {
      break;
    }
  }

  options.script = argv[index] ?? null;
  options.scriptArgs = argv.slice(index + 1);
  // `pnpm run <script> -- <args>` forwards the separator itself; it belongs to
  // pnpm, not to the script, so it never reaches the child.
  if (options.scriptArgs[0] === "--") options.scriptArgs = options.scriptArgs.slice(1);
  return options;
}

/** Spawns the resolved interpreter and mirrors its exit status. */
function run(script, scriptArgs, options) {
  return new Promise((resolve) => {
    let resolved;
    try {
      resolved = resolveNode({ requirement: options.requirement });
    } catch (error) {
      if (error instanceof NodeResolutionError) {
        process.stderr.write(`${error.code} ${error.message}\n`);
        resolve(1);
        return;
      }
      throw error;
    }

    const child = spawn(resolved.bin, [script, ...scriptArgs], {
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${path.dirname(resolved.bin)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    child.on("error", (error) => {
      process.stderr.write(`with-node: could not start ${resolved.bin}: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        const signum = os.constants.signals[signal] ?? 0;
        resolve(128 + signum);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(argv) {
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

  if (options.printBin) {
    try {
      const resolved = resolveNode({ requirement: options.requirement });
      process.stdout.write(`${resolved.bin}\n`);
      return 0;
    } catch (error) {
      if (error instanceof NodeResolutionError) {
        process.stderr.write(`${error.code} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }

  if (!options.script) {
    process.stderr.write(`with-node: no script given\n${USAGE}`);
    return 1;
  }

  return run(options.script, options.scriptArgs, options);
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
