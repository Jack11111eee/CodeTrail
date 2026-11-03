import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * AC-OPS-06: the report is sorted by package name, contains the fork itself as
 * `MIT`, and reports a package with no licence field as `unknown` instead of
 * dropping it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "licenses.mjs");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-licenses-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Report {
  packages: { name: string; version: string; license: string }[];
}

function runLicenses(args: string[]): {
  status: number | null;
  report: Report;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [SCRIPT, "--json", ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return {
    status: result.status,
    report: JSON.parse(result.stdout.trim()) as Report,
    stderr: result.stderr,
  };
}

describe("licence report", () => {
  it("includes the fork as MIT and sorts by package name", () => {
    const { report } = runLicenses([]);
    const names = report.packages.map((entry) => entry.name);
    expect(names).toEqual(
      [...names].sort((left, right) => left.localeCompare(right)),
    );

    const fork = report.packages.find((entry) => entry.name === "openwiki");
    expect(fork).toBeDefined();
    expect(fork?.license).toBe("MIT");
  });

  it("marks a package with no licence field unknown rather than omitting it", () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "forkfixture", version: "1.0.0", license: "MIT" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  alpha@1.0.0:",
        "    resolution: {integrity: sha512-alpha}",
        "",
        "  beta@2.0.0:",
        "    resolution: {integrity: sha512-beta}",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(root, "node_modules", "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "alpha", "package.json"),
      JSON.stringify({
        name: "alpha",
        version: "1.0.0",
        license: "Apache-2.0",
      }),
      "utf8",
    );
    fs.mkdirSync(path.join(root, "node_modules", "beta"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "beta", "package.json"),
      JSON.stringify({ name: "beta", version: "2.0.0" }),
      "utf8",
    );

    const { report } = runLicenses(["--root", root]);
    expect(report.packages.map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
      "forkfixture",
    ]);
    expect(
      report.packages.find((entry) => entry.name === "alpha")?.license,
    ).toBe("Apache-2.0");
    expect(
      report.packages.find((entry) => entry.name === "beta")?.license,
    ).toBe("unknown");
    expect(
      report.packages.find((entry) => entry.name === "forkfixture")?.license,
    ).toBe("MIT");
  });

  it("parses quoted scoped keys and ignores nested dependency blocks", () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "forkfixture", version: "1.0.0", license: "MIT" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  '@scope/pkg@3.0.0':",
        "    resolution: {integrity: sha512-scope}",
        "    peerDependencies:",
        "      '@nested/dep': ^1.0.0",
        "",
        "  alpha@1.0.0:",
        "    resolution: {integrity: sha512-alpha}",
        "",
        "snapshots:",
        "",
        "  '@scope/pkg@3.0.0': {}",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({
        name: "@scope/pkg",
        version: "3.0.0",
        license: "BSD-3-Clause",
      }),
      "utf8",
    );
    fs.mkdirSync(path.join(root, "node_modules", "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "alpha", "package.json"),
      JSON.stringify({ name: "alpha", version: "1.0.0", license: "MIT" }),
      "utf8",
    );

    const { report } = runLicenses(["--root", root]);
    const names = report.packages.map((entry) => entry.name);
    expect(names).toEqual(["@scope/pkg", "alpha", "forkfixture"]);
    expect(names.some((name) => name.includes("'"))).toBe(false);
    expect(
      report.packages.find((entry) => entry.name === "@scope/pkg")?.license,
    ).toBe("BSD-3-Clause");
    // The nested `peerDependencies` key is not a package entry.
    expect(names).not.toContain("@nested/dep");
  });
});
