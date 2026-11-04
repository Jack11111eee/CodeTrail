#!/usr/bin/env node
/**
 * Restore (architecture §13.2, §18; PRD §14).
 *
 *   node scripts/restore.mjs --from <dir> [--data-dir <dir>]
 *
 * Consumes an archive produced by `scripts/backup.mjs`. The implementation
 * lives next to the writer in `backup.mjs` so both halves share one path
 * rewrite and one git helper; this entry point only exposes the command and
 * re-exports `restoreBackup` for the ops test.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { restoreBackup } from "./backup.mjs";

export { restoreBackup } from "./backup.mjs";

function parseArgs(argv) {
  const options = { from: null, dataDir: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from") {
      options.from = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--from=")) {
      options.from = argument.slice("--from=".length);
    } else if (argument === "--data-dir") {
      options.dataDir = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--data-dir=")) {
      options.dataDir = argument.slice("--data-dir=".length);
    } else if (argument === "--json") {
      options.json = true;
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
    process.stdout.write(
      "usage: node scripts/restore.mjs --from <dir> [--data-dir <dir>] [--json]\n",
    );
    return 0;
  }
  if (options.from === null) {
    process.stderr.write("restore invalid_input: --from is required\n");
    return 2;
  }

  try {
    const result = await restoreBackup({
      fromDir: options.from,
      dataDir: options.dataDir ?? undefined,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `restore: ${result.dataDir} (${result.worktrees.length} worktrees, ${result.failures.length} failures)\n`,
    );
    return result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `restore ${error.code ?? "failed"}: ${error.message}` +
        (error.details ? ` ${JSON.stringify(error.details)}` : "") +
        "\n",
    );
    return 1;
  }
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
