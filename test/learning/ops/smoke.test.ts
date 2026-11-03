import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * AC-OPS-01 / AC-OPS-02: the smoke verdict itself.
 *
 * The source-mode run is always exercised: it boots the server on a temporary
 * data dir and an ephemeral loopback port, so a green result proves every
 * security surface and the page still answer as the acceptance gate expects.
 * The `--built` half only runs when the four build artifacts exist, because
 * `pnpm run test:learning` is also runnable without a build.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "smoke.mjs");
const BUILT_ARTIFACTS = [
  "dist/cli/cli.js",
  "dist/visualize/client.js",
  "dist/learning/api/cli.js",
  "dist/visualize/styles.css",
];

const builtReady = BUILT_ARTIFACTS.every((relative) =>
  fs.existsSync(path.join(REPO_ROOT, relative)),
);

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Report {
  ok: boolean;
  checks: Check[];
}

function runSmoke(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

function parseReport(stdout: string): Report {
  const line = stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as Report;
}

describe("smoke verdict", () => {
  it("exits 0 with every check ok on a temp data dir", () => {
    const result = runSmoke(["--json", "--timeout", "60000"]);
    expect(result.status, result.stderr).toBe(0);

    const report = parseReport(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.ok === true)).toBe(true);

    const names = report.checks.map((check) => check.name);
    for (const required of [
      "loopback_bind",
      "host_check",
      "auth_required",
      "projects_page",
      "health",
      "no_stray_process",
    ]) {
      expect(names, `missing check ${required}`).toContain(required);
    }

    const detail = new Map(
      report.checks.map((check) => [check.name, check.detail ?? ""]),
    );
    expect(detail.get("url_printed_loopback")).toContain("127.0.0.1");
    expect(detail.get("host_check")).toContain("403");
    expect(detail.get("auth_required")).toContain("401");
  });

  it("exits 2 and names the offending argument", () => {
    const result = runSmoke(["--not-a-real-flag"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  });

  it.skipIf(!builtReady)(
    "--built asserts the artifacts, the loopback URL and a literal zero SIGTERM exit",
    () => {
      const result = runSmoke(["--built", "--json", "--timeout", "60000"]);
      expect(result.status, result.stderr).toBe(0);

      const report = parseReport(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.checks.every((check) => check.ok === true)).toBe(true);

      const detail = new Map(
        report.checks.map((check) => [check.name, check.detail ?? ""]),
      );
      for (const required of [
        "built_artifacts",
        "built_entry_started",
        "url_printed_loopback",
        "sigterm_exit_zero",
        "no_stray_process",
      ]) {
        expect(detail.has(required), `missing check ${required}`).toBe(true);
      }
      expect(detail.get("built_artifacts")).toBe("all present");
      expect(detail.get("sigterm_exit_zero")).toBe("exit code 0");
    },
  );
});
