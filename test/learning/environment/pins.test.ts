import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNode, satisfies } from "../../../scripts/with-node.mjs";

/**
 * `check-env.mjs --pins` contract (AC-ENV-01/03).
 *
 * The pin check is what stops the fork from drifting away from the toolchain the
 * acceptance harness assumes, so each case here mutates exactly one pinned field
 * in a throwaway copy of the repository metadata and asserts that the command
 * fails *and* names that field. The interpreter used to spawn the script is the
 * one the launcher resolves, so the suite behaves the same on a machine whose
 * ambient `node` is older than `engines.node`.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHECK_ENV = path.join(REPO_ROOT, "scripts", "check-env.mjs");
const PINNED_NODE = resolveNode().bin;

const COPIED_FILES = [
  "package.json",
  "UPSTREAM_BASE.json",
  ".node-version",
  "tsconfig.json",
  "tsconfig.client.json",
  "README.md",
];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Check {
  field: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

interface Report {
  node: string;
  pnpm: string;
  sqliteFts5: string;
  upstreamCommit: string | null;
  nodeVersion: string;
  resolvedNode: string | null;
  resolvedVia: string | null;
  pins?: { ok: boolean; checks: Check[] };
}

function runCheckEnv(args: string[], cwd = REPO_ROOT): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      PINNED_NODE,
      [CHECK_ENV, ...args],
      { cwd, env: process.env, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parseReport(stdout: string): Report {
  return JSON.parse(stdout) as Report;
}

let dir: string;

/** Copies the metadata `--pins` reads into a throwaway root. */
async function makeRoot(): Promise<string> {
  const root = path.join(dir, "root");
  await mkdir(root, { recursive: true });
  for (const relative of COPIED_FILES) {
    const contents = await readFile(path.join(REPO_ROOT, relative), "utf8");
    await writeFile(path.join(root, relative), contents, "utf8");
  }
  return root;
}

async function editJson(
  root: string,
  relative: string,
  mutate: (value: Record<string, any>) => void,
): Promise<void> {
  const file = path.join(root, relative);
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  mutate(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codetrail-pins-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("--pins on the working tree", () => {
  it("reports every pinned field as ok and exits 0", async () => {
    const result = await runCheckEnv(["--pins"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const report = parseReport(result.stdout);
    expect(report.node).toBe("ok");
    expect(report.pnpm).toBe("ok");
    expect(report.sqliteFts5).toBe("ok");
    expect(report.upstreamCommit).toBe("7bb583d664f2d1c2484fa44b9d591f6103ca8166");
    expect(satisfies(report.nodeVersion)).toBe(true);
    expect(report.resolvedNode).toBe(PINNED_NODE);
    expect(report.resolvedVia).toBeTruthy();

    expect(report.pins?.ok).toBe(true);
    const fields = (report.pins?.checks ?? []).map((check) => check.field);
    expect(fields).toContain("engines.node");
    expect(fields).toContain("packageManager");
    expect(fields).toContain(".node-version");
    expect(fields).toContain("tsconfig.json.include");
    expect(fields.filter((field) => field === "tsconfig.json.exclude")).toHaveLength(2);
    expect(fields).toContain("tsconfig.client.json.include");
    expect(fields).toContain("tsconfig.client.json.lib");
  });

  it("passes through the pnpm command contract", async () => {
    const result = await new Promise<RunResult>((resolve) => {
      execFile(
        "pnpm",
        ["run", "--silent", "env:check", "--", "--pins"],
        { cwd: REPO_ROOT, env: process.env, timeout: 120_000 },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });

    expect(result.code).toBe(0);
    expect(parseReport(result.stdout).pins?.ok).toBe(true);
  });
});

describe("--pins on a mutated copy", () => {
  const cases: {
    name: string;
    field: string;
    mutate: (root: string) => Promise<void>;
  }[] = [
    {
      name: "engines.node",
      field: "engines.node",
      mutate: (root) =>
        editJson(root, "package.json", (manifest) => {
          manifest.engines.node = ">=22.0.0";
        }),
    },
    {
      name: "packageManager",
      field: "packageManager",
      mutate: (root) =>
        editJson(root, "package.json", (manifest) => {
          manifest.packageManager = "pnpm@10.33.1";
        }),
    },
    {
      name: ".node-version below the minimum",
      field: ".node-version",
      mutate: async (root) => {
        await writeFile(path.join(root, ".node-version"), "22.21.0\n", "utf8");
      },
    },
    {
      name: "missing .node-version",
      field: ".node-version",
      mutate: async (root) => {
        await rm(path.join(root, ".node-version"));
      },
    },
    {
      name: "tsconfig.json exclude without the client entry",
      field: "tsconfig.json.exclude",
      mutate: (root) =>
        editJson(root, "tsconfig.json", (config) => {
          config.exclude = config.exclude.filter(
            (entry: string) => entry !== "src/learning/ui/client.ts",
          );
        }),
    },
    {
      name: "tsconfig.json exclude without the client directory",
      field: "tsconfig.json.exclude",
      mutate: (root) =>
        editJson(root, "tsconfig.json", (config) => {
          config.exclude = config.exclude.filter(
            (entry: string) => entry !== "src/learning/ui/client/**",
          );
        }),
    },
    {
      name: "tsconfig.client.json include without the client entry",
      field: "tsconfig.client.json.include",
      mutate: (root) =>
        editJson(root, "tsconfig.client.json", (config) => {
          config.include = config.include.filter(
            (entry: string) => entry !== "src/learning/ui/client.ts",
          );
        }),
    },
  ];

  for (const testCase of cases) {
    it(`fails and names ${testCase.field} when ${testCase.name} drifts`, async () => {
      const root = await makeRoot();
      await testCase.mutate(root);

      const result = await runCheckEnv(["--pins", "--root", root]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("pins_mismatch");
      expect(result.stderr).toContain(testCase.field);

      const report = parseReport(result.stdout);
      expect(report.pins?.ok).toBe(false);
      const failing = (report.pins?.checks ?? []).filter((check) => !check.ok);
      expect(failing.map((check) => check.field)).toContain(testCase.field);
    });
  }
});
