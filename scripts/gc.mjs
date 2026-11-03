#!/usr/bin/env node
/**
 * Garbage collection (architecture §7.3, §7.4; AC-OPS-04).
 *
 *   node scripts/gc.mjs [--json] [--data-dir <dir>]
 *
 * Reclaims exactly two kinds of directory and nothing else:
 *
 *   staging/<jobId>      unless a queued, running or cancelling job owns it
 *   knowledge/<genId>    unless a published generation row references it
 *
 * `mirrors/**`, `work/**` and every published generation are never touched.
 * The keep-set is derived from `jobs.state` / `generations.status`, never from
 * directory age — a published version is the learner's history and deleting it
 * is irreversible.
 *
 * The report matches `GcReport`:
 *   {removedWorkspaces, removedKnowledge, keptPublished, keptInFlight, bytesFreed}
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePaths } from "./backup.mjs";

const IN_FLIGHT = new Set(["queued", "running", "cancelling"]);

function listFilesRecursive(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function treeBytes(root) {
  let total = 0;
  for (const file of listFilesRecursive(root)) {
    try {
      total += fs.statSync(file).size;
    } catch {
      // A concurrently removed file contributes nothing.
    }
  }
  return total;
}

/** Sealed knowledge files are 0444; make the tree removable before `rm`. */
function makeTreeWritable(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeTreeWritable(absolute);
      try {
        fs.chmodSync(absolute, 0o755);
      } catch {
        // Best effort.
      }
    } else {
      try {
        fs.chmodSync(absolute, 0o644);
      } catch {
        // Best effort.
      }
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // Best effort.
  }
}

function removeTree(root) {
  if (!fs.existsSync(root)) return;
  makeTreeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function directoryEntries(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Runs the collector.
 *
 * @param {{env?: NodeJS.ProcessEnv, dataDir?: string}} [options]
 * @returns {Promise<{removedWorkspaces: string[], removedKnowledge: string[],
 *   keptPublished: number, keptInFlight: number, bytesFreed: number}>}
 */
export async function runGc(options = {}) {
  const env = options.env ?? process.env;
  const paths = resolvePaths(
    options.dataDir === undefined
      ? env
      : { ...env, CODETRAIL_DATA_DIR: options.dataDir },
  );

  const jobs = new Map();
  const generations = new Map();
  if (fs.existsSync(paths.db)) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(paths.db, { readOnly: true });
    try {
      for (const row of database.prepare("SELECT job_id, state FROM jobs").all()) {
        jobs.set(row.job_id, row.state);
      }
      for (const row of database
        .prepare("SELECT generation_id, status FROM generations")
        .all()) {
        generations.set(row.generation_id, row.status);
      }
    } finally {
      database.close();
    }
  }

  const report = {
    removedWorkspaces: [],
    removedKnowledge: [],
    keptPublished: 0,
    keptInFlight: 0,
    bytesFreed: 0,
  };

  for (const entry of directoryEntries(paths.staging)) {
    if (!entry.isDirectory()) continue;
    const workspace = path.join(paths.staging, entry.name);
    const state = jobs.get(entry.name);
    if (state !== undefined && IN_FLIGHT.has(state)) {
      report.keptInFlight += 1;
      continue;
    }
    report.bytesFreed += treeBytes(workspace);
    removeTree(workspace);
    report.removedWorkspaces.push(workspace);
  }

  for (const entry of directoryEntries(paths.knowledge)) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(paths.knowledge, entry.name);
    if (generations.get(entry.name) === "published") {
      report.keptPublished += 1;
      continue;
    }
    report.bytesFreed += treeBytes(directory);
    removeTree(directory);
    report.removedKnowledge.push(entry.name);
  }

  return report;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { json: false, dataDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--data-dir") {
      options.dataDir = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--data-dir=")) {
      options.dataDir = argument.slice("--data-dir=".length);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--") {
      continue;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write("usage: node scripts/gc.mjs [--json] [--data-dir <dir>]\n");
    return 0;
  }

  const report = await runGc({ dataDir: options.dataDir ?? undefined });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(
      `gc: removed ${report.removedWorkspaces.length} workspaces and ` +
        `${report.removedKnowledge.length} knowledge dirs, ` +
        `kept ${report.keptPublished} published / ${report.keptInFlight} in flight, ` +
        `freed ${report.bytesFreed} bytes\n`,
    );
  }
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
