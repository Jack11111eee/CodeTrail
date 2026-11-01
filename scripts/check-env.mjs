#!/usr/bin/env node
/**
 * Environment report for the pinned toolchain.
 *
 *   node scripts/check-env.mjs [--simulate-node <version>] [--pins] [--audit-global] [--root <dir>]
 *
 * Prints one JSON object on stdout:
 *   `{node, pnpm, sqliteFts5, upstreamCommit, nodeVersion, resolvedNode, resolvedVia}`
 * and exits non-zero when any of them is not usable. Modes:
 *
 *   --simulate-node <v>  report as if the interpreter were `<v>`; a version below
 *                        `engines.node` exits non-zero with `node_version_unsupported`.
 *                        Handled before anything else — in particular before
 *                        `node:sqlite` is imported — so it also works on an old
 *                        ambient interpreter and never writes any global Node config.
 *   --pins               additionally validates `engines.node`, `packageManager`,
 *                        `.node-version` and the TypeScript project split; a
 *                        mismatch exits non-zero naming the failing field.
 *   --audit-global       additionally scans `scripts/`, `package.json` and
 *                        `README.md` for global-Node-mutation commands, and
 *                        checks that the launcher only augments the child `PATH`.
 *   --root <dir>         read the checked files from `<dir>` instead of this repo
 *                        (used by the tests to mutate one field at a time).
 *
 * This file must run on any Node >= 16: it imports nothing but `node:` builtins
 * and `with-node.mjs`, and loads `node:sqlite` dynamically.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REQUIREMENT,
  NodeResolutionError,
  parseVersion,
  resolveNode,
  satisfies,
} from "./with-node.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const MANIFEST_FILE = "UPSTREAM_BASE.json";
const PINNED_UPSTREAM_COMMIT = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";
const REQUIRED_ENGINES_NODE = ">=22.22.0";
const REQUIRED_PACKAGE_MANAGER = "pnpm@11.25.0";
const LEARNING_INCLUDE = "src/learning/**/*.ts";
const LEARNING_CLIENT = "src/learning/ui/client.ts";
const LEARNING_CLIENT_DIR = "src/learning/ui/client/**";

const USAGE = `usage: node scripts/check-env.mjs [--simulate-node <version>] [--pins] [--audit-global] [--root <dir>]
`;

/**
 * Commands that would mutate the machine's default Node installation. They are
 * assembled from parts on purpose: `--audit-global` scans `scripts/` (including
 * this file), so a literal here would make the audit flag itself.
 */
const FORBIDDEN_GLOBAL_COMMANDS = [
  ["nvm", "alias", "default"].join(" "),
  ["nvm", "install"].join(" "),
  ["brew", "link"].join(" "),
  ["npm", "i", "-g"].join(" "),
];

/**
 * Filesystem APIs that would let the launcher write outside the repository:
 * the mutating entry points of `node:fs` and `node:fs/promises`, including the
 * bare `open`/`openSync` that only write when given a write flag.
 */
const LAUNCHER_WRITE_PATTERN =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|rm|rmdirSync|rmdir|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|chmodSync|chmod|createWriteStream|openSync|open)\b/u;

function parseArgs(argv) {
  const options = {
    simulateNode: null,
    pins: false,
    auditGlobal: false,
    root: REPO_ROOT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--simulate-node") {
      const value = argv[index + 1];
      if (!value) throw new Error("--simulate-node needs a version");
      options.simulateNode = value;
      index += 1;
    } else if (arg.startsWith("--simulate-node=")) {
      options.simulateNode = arg.slice("--simulate-node=".length);
    } else if (arg === "--pins") {
      options.pins = true;
    } else if (arg === "--audit-global") {
      options.auditGlobal = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root needs a directory");
      options.root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--") {
      // `pnpm run env:check -- --pins` forwards the separator; ignore it.
      continue;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function readText(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), "utf8");
  } catch {
    return null;
  }
}

function readJson(root, relative) {
  const text = readText(root, relative);
  if (text === null) return { error: `${relative} is missing` };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `${relative} is not valid JSON: ${error.message}` };
  }
}

/**
 * Reports whether a pnpm answers at all. The pin itself is validated by
 * `--pins` against `packageManager`, because the `pnpm` on `PATH` may be a
 * launcher that defers to the version the project pins.
 */
function pnpmAvailable() {
  const result = spawnSync("pnpm", ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) return false;
  return parseVersion(result.stdout) !== null;
}

/**
 * Runs `probe` with the `ExperimentalWarning` that `node:sqlite` raises on
 * import filtered out.
 *
 * The report is the contract here, so stderr must stay clean; but the host may
 * have installed its own `warning` listeners (vitest does), so this filters the
 * warning at the source for the duration of the probe instead of removing
 * listeners it did not add. `process.emitWarning` is restored in `finally`.
 */
async function withoutSqliteWarning(probe) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const message =
      typeof warning === "string" ? warning : (warning?.message ?? "");
    if (/SQLite is an experimental feature/u.test(String(message))) return;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    return await probe();
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Proves the running interpreter can open an in-memory database and use an
 * FTS5 virtual table with the tokenizer the retrieval layer relies on.
 */
async function sqliteFts5() {
  return withoutSqliteWarning(async () => {
    let sqlite;
    try {
      sqlite = await import("node:sqlite");
    } catch {
      return { ok: false, detail: "node:sqlite is unavailable" };
    }

    let database;
    try {
      database = new sqlite.DatabaseSync(":memory:");
      database.exec(
        "CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = 'porter unicode61')",
      );
      database
        .prepare("INSERT INTO probe(body) VALUES (?)")
        .run("旧快照丢了 snapshot evicted");
      const row = database
        .prepare("SELECT count(*) AS matches FROM probe WHERE probe MATCH ?")
        .get("snapshot");
      if (!row || Number(row.matches) < 1) {
        return { ok: false, detail: "fts5 query returned no rows" };
      }
      return { ok: true, detail: "fts5 porter unicode61" };
    } catch (error) {
      return { ok: false, detail: `fts5 probe failed: ${error.message}` };
    } finally {
      try {
        database?.close();
      } catch {
        // Nothing left to close.
      }
    }
  });
}

function upstreamCommit(root) {
  const manifest = readJson(root, MANIFEST_FILE);
  const commit = manifest.value?.upstream?.commit;
  return typeof commit === "string" ? commit : null;
}

function hasEntry(list, entry) {
  return Array.isArray(list) && list.includes(entry);
}

/**
 * Validates the pins the whole toolchain depends on. Every entry names the
 * field it checked, so a mismatch says what to fix.
 */
function checkPins(root) {
  const checks = [];
  const record = (field, ok, expected, actual) => {
    checks.push({ field, ok, expected, actual });
  };

  const manifest = readJson(root, "package.json");
  const enginesNode = manifest.value?.engines?.node;
  record("engines.node", enginesNode === REQUIRED_ENGINES_NODE, REQUIRED_ENGINES_NODE, enginesNode ?? null);

  const packageManager = manifest.value?.packageManager;
  record(
    "packageManager",
    packageManager === REQUIRED_PACKAGE_MANAGER,
    REQUIRED_PACKAGE_MANAGER,
    packageManager ?? null,
  );

  const pinned = readText(root, ".node-version");
  const pinnedVersion = pinned === null ? null : pinned.split(/\r?\n/u)[0].trim();
  record(
    ".node-version",
    pinnedVersion !== null &&
      pinnedVersion !== "" &&
      satisfies(pinnedVersion, DEFAULT_REQUIREMENT),
    `a version satisfying ${DEFAULT_REQUIREMENT}`,
    pinnedVersion === null || pinnedVersion === "" ? null : pinnedVersion,
  );

  const server = readJson(root, "tsconfig.json");
  const serverInclude = server.value?.include;
  record(
    "tsconfig.json.include",
    hasEntry(serverInclude, LEARNING_INCLUDE),
    LEARNING_INCLUDE,
    serverInclude ?? null,
  );
  const serverExclude = server.value?.exclude;
  record(
    "tsconfig.json.exclude",
    hasEntry(serverExclude, LEARNING_CLIENT),
    LEARNING_CLIENT,
    serverExclude ?? null,
  );
  record(
    "tsconfig.json.exclude",
    hasEntry(serverExclude, LEARNING_CLIENT_DIR),
    LEARNING_CLIENT_DIR,
    serverExclude ?? null,
  );

  const client = readJson(root, "tsconfig.client.json");
  const clientInclude = client.value?.include;
  record(
    "tsconfig.client.json.include",
    hasEntry(clientInclude, LEARNING_CLIENT),
    LEARNING_CLIENT,
    clientInclude ?? null,
  );
  const clientLib = client.value?.compilerOptions?.lib;
  for (const lib of ["DOM", "ES2022"]) {
    record("tsconfig.client.json.lib", hasEntry(clientLib, lib), lib, clientLib ?? null);
  }

  return { ok: checks.every((entry) => entry.ok), checks };
}

function listFiles(root, relative) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return [];
  }
  if (stat.isFile()) return [relative];

  const found = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(root, child));
    } else if (entry.isFile()) {
      found.push(child);
    }
  }
  return found;
}

/**
 * Proves nothing in the repository would mutate the machine's default Node
 * installation, and that the launcher stays read-only.
 */
function auditGlobal(root) {
  const scanned = [
    "package.json",
    "README.md",
    ...listFiles(root, "scripts").sort(),
  ].filter((relative) => fs.existsSync(path.join(root, relative)));

  const hits = [];
  for (const relative of scanned) {
    const text = readText(root, relative);
    if (text === null) continue;
    const lines = text.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const token of FORBIDDEN_GLOBAL_COMMANDS) {
        if (line.includes(token)) hits.push({ file: relative, line: index + 1, command: token });
      }
    }
  }

  const launcher = readText(root, "scripts/with-node.mjs");
  const checks = [
    { field: "launcher.present", ok: launcher !== null, expected: "scripts/with-node.mjs", actual: launcher === null ? null : "present" },
    {
      field: "launcher.path-only",
      ok: launcher !== null && launcher.includes("process.env.PATH") && launcher.includes("path.delimiter"),
      expected: "augments the child PATH",
      actual: launcher === null ? null : "checked",
    },
    {
      field: "launcher.read-only",
      ok: launcher !== null && !LAUNCHER_WRITE_PATTERN.test(launcher),
      expected: "no filesystem writes",
      actual: launcher === null ? null : "checked",
    },
  ];

  return {
    ok: hits.length === 0 && checks.every((entry) => entry.ok),
    forbidden: [...FORBIDDEN_GLOBAL_COMMANDS],
    scanned,
    hits,
    checks,
  };
}

function reportFailures(label, entries) {
  for (const entry of entries) {
    if (entry.ok) continue;
    process.stderr.write(
      `${label} ${entry.field}: expected ${JSON.stringify(entry.expected)}, found ${JSON.stringify(entry.actual)}\n`,
    );
  }
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

  // Checked before anything else: no probe runs, no `node:sqlite` import, and
  // no configuration is written, so this works on an old ambient interpreter.
  if (options.simulateNode !== null) {
    const simulated = parseVersion(options.simulateNode);
    if (!simulated || !satisfies(simulated.version, DEFAULT_REQUIREMENT)) {
      process.stderr.write(
        `node_version_unsupported simulated ${options.simulateNode} does not satisfy ${DEFAULT_REQUIREMENT}\n`,
      );
      return 1;
    }
  }

  const failures = [];

  const sqlite = await sqliteFts5();
  const pnpmOk = pnpmAvailable();
  const commit = upstreamCommit(options.root);

  let resolved = null;
  let resolutionError = null;
  try {
    resolved = resolveNode({ repoRoot: options.root });
  } catch (error) {
    if (!(error instanceof NodeResolutionError)) throw error;
    resolutionError = error;
  }

  // The verdict describes the interpreter every script will actually run under,
  // not the ambient one that happened to start this file. AC-ENV-04 calls
  // `node scripts/check-env.mjs --audit-global`, and that `node` may be below
  // `engines.node`; the launcher still resolves a usable interpreter for the
  // scripts, so only the resolved version decides `node`.
  const nodeVersion =
    options.simulateNode ??
    resolved?.version ??
    parseVersion(process.version)?.version ??
    process.version;
  const nodeOk =
    resolved !== null && satisfies(resolved.version, DEFAULT_REQUIREMENT);
  const commitOk = commit === PINNED_UPSTREAM_COMMIT;

  if (!nodeOk) {
    const message = resolutionError
      ? `${resolutionError.code} ${resolutionError.message}`
      : `node_version_unsupported ${nodeVersion} does not satisfy ${DEFAULT_REQUIREMENT}`;
    process.stderr.write(`${message}\n`);
    failures.push("node_version_unsupported");
  }
  if (!pnpmOk) {
    process.stderr.write("pnpm_unavailable pnpm --version did not run\n");
    failures.push("pnpm_unavailable");
  }
  if (!sqlite.ok) {
    process.stderr.write(`sqlite_fts5_unavailable ${sqlite.detail}\n`);
    failures.push("sqlite_fts5_unavailable");
  }
  if (!commitOk) {
    process.stderr.write(`upstream_commit_mismatch ${commit ?? "(missing)"}\n`);
    failures.push("upstream_commit_mismatch");
  }

  const report = {
    node: nodeOk ? "ok" : "fail",
    pnpm: pnpmOk ? "ok" : "fail",
    sqliteFts5: sqlite.ok ? "ok" : "fail",
    upstreamCommit: commit,
    nodeVersion,
    resolvedNode: resolved ? resolved.bin : null,
    resolvedVia: resolved ? resolved.via : null,
  };

  if (options.pins) {
    report.pins = checkPins(options.root);
    if (!report.pins.ok) {
      reportFailures("pins_mismatch", report.pins.checks);
      failures.push("pins_mismatch");
    }
  }

  if (options.auditGlobal) {
    report.auditGlobal = auditGlobal(options.root);
    if (!report.auditGlobal.ok) {
      for (const hit of report.auditGlobal.hits) {
        process.stderr.write(
          `global_node_mutation ${hit.file}:${hit.line}: ${hit.command}\n`,
        );
      }
      reportFailures("global_audit_failed", report.auditGlobal.checks);
      failures.push("global_audit_failed");
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  return failures.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
