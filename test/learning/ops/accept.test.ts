import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The acceptance harness runs its gates in the normative order and stops at the
 * first red step. A fake `pnpm` on `PATH` records every invocation, so this
 * test proves the order and the fail-fast rule without rebuilding the project.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "accept.mjs");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-accept-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function installFakePnpm(binDir: string): void {
  const file = path.join(binDir, "pnpm");
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'echo "$*" >> "$ACCEPT_LOG"',
      'if [ "$*" = "run build" ] && [ -n "$ACCEPT_FAIL" ]; then',
      '  exit "$ACCEPT_FAIL"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(file, 0o755);
}

function runAccept(root: string, logFile: string, failCode?: number) {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  installFakePnpm(binDir);

  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--json", "--root", root],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        ACCEPT_LOG: logFile,
        ...(failCode === undefined ? {} : { ACCEPT_FAIL: String(failCode) }),
      },
    },
  );
  const invocations = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").trim().split("\n")
    : [];
  return { result, invocations };
}

describe("accept harness", () => {
  it("runs env, provenance, typecheck, build, both suites and smoke in order", () => {
    const root = makeTempDir();
    const logFile = path.join(root, "invocations.log");
    const { result, invocations } = runAccept(root, logFile);

    expect(result.status, result.stderr).toBe(0);
    expect(invocations).toEqual([
      "run env:check",
      "run provenance:check",
      "run typecheck",
      "run build",
      "run test:upstream",
      "run test:learning",
      "run smoke",
    ]);

    const report = JSON.parse(
      fs.readFileSync(path.join(root, ".artifacts", "accept", "report.json"), "utf8"),
    ) as { ok: boolean; steps: { name: string; ok: boolean }[] };
    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.name)).toEqual([
      "env",
      "provenance",
      "typecheck",
      "build",
      "test:upstream",
      "test:learning",
      "smoke",
    ]);
    expect(report.steps.every((step) => step.ok)).toBe(true);
  });

  it("writes the report but never continues past a red step", () => {
    const root = makeTempDir();
    const logFile = path.join(root, "invocations.log");
    const { result, invocations } = runAccept(root, logFile, 7);

    expect(result.status).toBe(1);
    expect(invocations).toEqual([
      "run env:check",
      "run provenance:check",
      "run typecheck",
      "run build",
    ]);

    const report = JSON.parse(
      fs.readFileSync(path.join(root, ".artifacts", "accept", "report.json"), "utf8"),
    ) as { ok: boolean; steps: { name: string; ok: boolean; skipped?: boolean }[] };
    expect(report.ok).toBe(false);
    const build = report.steps.find((step) => step.name === "build");
    expect(build).toMatchObject({ ok: false, exitCode: 7 });
    for (const name of ["test:upstream", "test:learning", "smoke"]) {
      expect(report.steps.find((step) => step.name === name)).toMatchObject({
        skipped: true,
        ok: false,
      });
    }
  });
});
