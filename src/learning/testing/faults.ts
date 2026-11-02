/**
 * Crash and Git fault doubles (architecture §17.3, PRD §15.2 items 4–5).
 *
 * `faultPoint` is a process-level crash switch: when `CODETRAIL_FAULT_INJECT`
 * names the current point the process exits with status 1, which lets a parent
 * test observe a crash exactly at the seal/rename/transaction boundary. Every
 * other value — absent, a different point, a typo — is a no-op.
 *
 * `makeBareRemote` points a clone at a fixture repository on disk, so the Git
 * suite never touches a network remote.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The injection points referenced by the publish pipeline (architecture §7.2). */
export type FaultPointName = "seal" | "rename" | "tx_before" | "tx_after";

export const FAULT_POINT_NAMES: readonly FaultPointName[] = Object.freeze([
  "seal",
  "rename",
  "tx_before",
  "tx_after",
]);

function injectedFault(): string | null {
  const raw = process.env.CODETRAIL_FAULT_INJECT;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Terminates the process with status 1 when the injected fault matches. */
export function faultPoint(name: FaultPointName): void {
  if (injectedFault() !== name) return;
  process.stderr.write(`codetrail: injected fault at ${name}\n`);
  process.exit(1);
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Absolute `file://` URL for the bare fixture repository `<fixturesDir>/<name>`
 * (or `<name>.git` when the fixture directory uses the bare-repo suffix).
 */
export function makeBareRemote(fixturesDir: string, name: string): string {
  const base = path.resolve(fixturesDir);
  const candidates = name.endsWith(".git") ? [name] : [name, `${name}.git`];
  let chosen = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    if (isDirectory(path.join(base, candidate))) {
      chosen = candidate;
      break;
    }
  }
  return pathToFileURL(path.join(base, chosen)).href;
}
