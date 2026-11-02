import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNode } from "../../../scripts/with-node.mjs";

/**
 * `check-env.mjs --audit-global` and `--simulate-node` contract (AC-ENV-02/04).
 *
 * The fork must never mutate the machine's default Node installation — only the
 * child process `PATH` may be adjusted — so the audit is exercised in both
 * directions: the real repository must be clean, and a planted command or a
 * launcher that writes must be caught with its file and line.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHECK_ENV = path.join(REPO_ROOT, "scripts", "check-env.mjs");
const PINNED_NODE = resolveNode().bin;

const ROOT_FILES = ["package.json", "README.md", "UPSTREAM_BASE.json", ".node-version"];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface AuditReport {
  auditGlobal?: {
    ok: boolean;
    forbidden: string[];
    scanned: string[];
    hits: { file: string; line: number; command: string }[];
    checks: { field: string; ok: boolean }[];
  };
  node?: string;
  nodeVersion?: string;
  resolvedNode?: string | null;
  resolvedVia?: string | null;
}

function runCheckEnv(
  args: string[],
  env: Record<string, string> = {},
  cwd = REPO_ROOT,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      PINNED_NODE,
      [CHECK_ENV, ...args],
      { cwd, env: { ...process.env, ...env }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        found.push(child);
      }
    }
  };
  await walk("");
  return found.sort();
}

let dir: string;
let root: string;
let home: string;

/** A root that mirrors the files the audit and the default checks read. */
async function makeRoot(): Promise<string> {
  const target = path.join(dir, "root");
  await mkdir(target, { recursive: true });
  for (const relative of ROOT_FILES) {
    const contents = await readFile(path.join(REPO_ROOT, relative), "utf8");
    await writeFile(path.join(target, relative), contents, "utf8");
  }
  await cp(path.join(REPO_ROOT, "scripts"), path.join(target, "scripts"), {
    recursive: true,
  });
  return target;
}

/** A stand-in interpreter that only has to answer `--version`. */
async function writeFakeNode(directory: string, version: string): Promise<string> {
  const bin = path.join(directory, "node");
  await mkdir(directory, { recursive: true });
  await writeFile(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'v${version}\\n'; exit 0; fi\nexit 0\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codetrail-global-audit-"));
  home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  root = await makeRoot();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("--audit-global", () => {
  it("finds no global-Node mutation command in scripts/, package.json or README.md", async () => {
    const result = await runCheckEnv(["--audit-global"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.auditGlobal?.ok).toBe(true);
    expect(report.auditGlobal?.hits).toEqual([]);
    expect(report.auditGlobal?.scanned).toContain("package.json");
    expect(report.auditGlobal?.scanned).toContain("README.md");
    expect(report.auditGlobal?.scanned).toContain("scripts/with-node.mjs");
    for (const check of report.auditGlobal?.checks ?? []) {
      expect(check.ok, check.field).toBe(true);
    }
  });

  it("reports the file and line of a planted mutation command", async () => {
    const planted = path.join(root, "scripts", "planted.mjs");
    await writeFile(planted, 'export const a = 1;\nconst run = "nvm install 22";\n', "utf8");

    const result = await runCheckEnv(["--audit-global", "--root", root]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("global_node_mutation");
    expect(result.stderr).toContain("scripts/planted.mjs:2");
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.auditGlobal?.ok).toBe(false);
    expect(report.auditGlobal?.hits).toEqual([
      { file: "scripts/planted.mjs", line: 2, command: "nvm install" },
    ]);
  });

  it("fails when the launcher could write outside the repository", async () => {
    const launcher = path.join(root, "scripts", "with-node.mjs");
    const contents = await readFile(launcher, "utf8");
    await writeFile(
      launcher,
      `${contents}\nexport const leak = () => writeFileSync("/tmp/leak", "x");\n`,
      "utf8",
    );

    const result = await runCheckEnv(["--audit-global", "--root", root]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("launcher.read-only");
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.auditGlobal?.checks.find((check) => check.field === "launcher.read-only")?.ok).toBe(
      false,
    );
  });

  it("catches every mutating filesystem API the launcher guard covers", async () => {
    // One API is not enough: the guard is an alternation, so a dropped branch
    // (or a typo in one) would let that write path through unnoticed.
    const mutators = [
      "appendFileSync",
      "appendFile",
      "mkdirSync",
      "rmSync",
      "rmdir",
      "unlinkSync",
      "rename",
      "copyFile",
      "chmodSync",
      "createWriteStream",
      "open",
    ];
    const launcher = path.join(root, "scripts", "with-node.mjs");
    const original = await readFile(launcher, "utf8");

    try {
      for (const mutator of mutators) {
        await writeFile(
          launcher,
          `${original}\nexport const leak = () => ${mutator}("/tmp/leak", "x");\n`,
          "utf8",
        );

        const result = await runCheckEnv(["--audit-global", "--root", root]);

        expect(result.code, mutator).not.toBe(0);
        expect(result.stderr, mutator).toContain("launcher.read-only");
        const report = JSON.parse(result.stdout) as AuditReport;
        expect(
          report.auditGlobal?.checks.find(
            (check) => check.field === "launcher.read-only",
          )?.ok,
          mutator,
        ).toBe(false);
      }
    } finally {
      await writeFile(launcher, original, "utf8");
    }
  });
});

describe("--audit-global token coverage", () => {
  /**
   * Every command AC-ENV-04 names. The coder's suite only planted `nvm
   * install`, so a typo or a dropped entry in the forbidden list would have
   * passed unnoticed for the other three.
   */
  const FORBIDDEN = ["nvm alias default", "nvm install", "brew link", "npm i -g"];

  /**
   * Plants `token` in all three scanned targets at once: `package.json` as a
   * script body, `README.md` as a trailing instruction and `scripts/` as a new
   * file. One assertion therefore proves the audit greps every documented
   * location, not only the one the other tests happen to use.
   */
  async function plantEverywhere(target: string, token: string): Promise<void> {
    const manifestPath = path.join(target, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["install-toolchain"] = token;
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await appendFile(
      path.join(target, "README.md"),
      `\nRun \`${token}\` before the first build.\n`,
      "utf8",
    );

    await writeFile(
      path.join(target, "scripts", "planted.mjs"),
      `// ${token}\n`,
      "utf8",
    );
  }

  for (const token of FORBIDDEN) {
    it(`catches \`${token}\` in package.json, README.md and scripts/`, async () => {
      await plantEverywhere(root, token);

      const result = await runCheckEnv(["--audit-global", "--root", root]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("global_node_mutation");
      expect(result.stderr).toContain(token);

      const report = JSON.parse(result.stdout) as AuditReport;
      expect(report.auditGlobal?.ok).toBe(false);
      const hits = report.auditGlobal?.hits ?? [];
      expect(hits.map((hit) => hit.file).sort()).toEqual([
        "README.md",
        "package.json",
        "scripts/planted.mjs",
      ]);
      expect(new Set(hits.map((hit) => hit.command))).toEqual(new Set([token]));
      for (const hit of hits) expect(hit.line).toBeGreaterThan(0);
    });
  }

  it("does not flag a README that merely names the version requirement", async () => {
    // The minimal README must be able to say "Node.js 22.22.0 or newer" and
    // describe the launcher without tripping the audit.
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("Node.js 22.22.0 or newer");
    await appendFile(
      path.join(root, "README.md"),
      "\nUse the version pinned in `.node-version`; the launcher never installs a runtime.\n",
      "utf8",
    );

    const result = await runCheckEnv(["--audit-global", "--root", root]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.auditGlobal?.hits).toEqual([]);
  });
});

describe("--simulate-node", () => {
  it("rejects 22.21.99 (one patch below the floor)", async () => {
    const result = await runCheckEnv(["--simulate-node", "22.21.99"], { HOME: home });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node_version_unsupported");
  });

  it("rejects 22.21.0 (the reference machine's ambient interpreter)", async () => {
    const result = await runCheckEnv(["--simulate-node", "22.21.0"], { HOME: home });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node_version_unsupported");
  });

  it("accepts the exact floor 22.22.0", async () => {
    const result = await runCheckEnv(["--simulate-node", "22.22.0"]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.nodeVersion).toBe("22.22.0");
  });

  it("rejects a non-semver --simulate-node value instead of guessing", async () => {
    const result = await runCheckEnv(["--simulate-node", "latest"], { HOME: home });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node_version_unsupported");
  });

  it("writes no global Node configuration anywhere outside the repository", async () => {
    const before = await listFiles(home);

    await runCheckEnv(["--simulate-node", "22.21.0"], { HOME: home });
    await runCheckEnv(["--audit-global"], { HOME: home });

    expect(await listFiles(home)).toEqual(before);
    expect(before).toEqual([]);
  });
});

describe("node verdict (AC-ENV-01/04)", () => {
  /**
   * AC-ENV-04 runs `node scripts/check-env.mjs --audit-global`, and that `node`
   * may be below `engines.node`. The report must describe the interpreter the
   * scripts will run under, so it is pinned here to a version that differs from
   * whatever interpreter is executing the test: a verdict taken from
   * `process.version` would report the ambient version instead.
   */
  it("reports the resolved interpreter's version, not the ambient one", async () => {
    await writeFile(path.join(root, ".node-version"), "23.0.0\n", "utf8");
    const pinned = await writeFakeNode(
      path.join(home, ".nvm", "versions", "node", "v23.0.0", "bin"),
      "23.0.0",
    );

    const result = await runCheckEnv(["--root", root], { HOME: home });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.node).toBe("ok");
    expect(report.nodeVersion).toBe("23.0.0");
    expect(report.resolvedNode).toBe(pinned);
    expect(report.resolvedVia).toBe("nvm");
  });

  it("reports node fail and exits non-zero when no interpreter resolves", async () => {
    await writeFile(path.join(root, ".node-version"), "99.0.0\n", "utf8");
    const emptyPath = path.join(dir, "empty-path");
    await mkdir(emptyPath, { recursive: true });

    const result = await runCheckEnv(["--root", root], {
      HOME: home,
      PATH: emptyPath,
      CODETRAIL_NODE_BIN: "",
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node_version_unsupported");
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.node).toBe("fail");
    expect(report.resolvedNode).toBeNull();
  });
});

describe("resolution is read-only", () => {
  it("only reads the probed installs, never creating or modifying them", async () => {
    const pinned = await writeFakeNode(
      path.join(home, ".nvm", "versions", "node", "v24.13.0", "bin"),
      "24.13.0",
    );
    const before = await listFiles(home);

    const result = await runCheckEnv([], { HOME: home });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as AuditReport;
    expect(report.resolvedNode).toBe(pinned);
    expect(report.resolvedVia).toBe("nvm");
    expect(await listFiles(home)).toEqual(before);
  });
});
