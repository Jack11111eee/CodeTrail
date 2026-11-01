import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NodeResolutionError,
  probeCandidates,
  resolveNode,
  satisfies,
} from "../../../scripts/with-node.mjs";

/**
 * Pinned-runtime launcher contract (AC-ENV-01/02).
 *
 * `scripts/with-node.mjs` is the only thing standing between a machine whose
 * ambient `node` is older than `engines.node` and a toolchain that silently
 * runs on it, so every assertion here exercises the real file: either the
 * exported `resolveNode` (resolution order) or the CLI (spawn, exit codes,
 * signal propagation).
 *
 * The cases that must not resolve fake the pinned version with `99.0.0`, so no
 * interpreter that happens to be installed on the test machine can satisfy the
 * probes and turn a deterministic assertion into an environment-dependent one.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LAUNCHER = path.join(REPO_ROOT, "scripts", "with-node.mjs");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface LauncherError extends Error {
  code: string;
  probed: { via: string; bin: string; reason: string }[];
}

function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LAUNCHER, ...args],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

let dir: string;
let repoRoot: string;
let home: string;

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

/** The `nvm` install layout the launcher probes first. */
function nvmNode(homeDir: string, version: string): string {
  return path.join(homeDir, ".nvm", "versions", "node", `v${version}`, "bin");
}

async function pinVersion(version: string): Promise<void> {
  await writeFile(path.join(repoRoot, ".node-version"), `${version}\n`, "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codetrail-with-node-"));
  repoRoot = path.join(dir, "repo");
  home = path.join(dir, "home");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await pinVersion("24.13.0");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("satisfies", () => {
  it("compares the patch version, not just the major and minor", () => {
    expect(satisfies("22.21.99")).toBe(false);
    expect(satisfies("22.22.0")).toBe(true);
    expect(satisfies("v24.13.0")).toBe(true);
    expect(satisfies("22.22.0", ">22.22.0")).toBe(false);
    expect(satisfies("22.22.0", "<=22.22.0")).toBe(true);
    expect(satisfies("not-a-version")).toBe(false);
  });
});

describe("resolveNode", () => {
  it("uses CODETRAIL_NODE_BIN first when it satisfies the requirement", async () => {
    const configured = await writeFakeNode(path.join(dir, "configured"), "24.13.0");
    await writeFakeNode(nvmNode(home, "24.13.0"), "24.13.0");

    const resolved = resolveNode({
      env: { CODETRAIL_NODE_BIN: configured, HOME: home, PATH: "" },
      repoRoot,
    });

    expect(resolved.via).toBe("CODETRAIL_NODE_BIN");
    expect(resolved.bin).toBe(configured);
    expect(resolved.version).toBe("24.13.0");
  });

  it("skips a CODETRAIL_NODE_BIN that is too old and uses the .node-version install", async () => {
    const configured = await writeFakeNode(path.join(dir, "configured"), "22.21.0");
    const pinned = await writeFakeNode(nvmNode(home, "24.13.0"), "24.13.0");

    const resolved = resolveNode({
      env: { CODETRAIL_NODE_BIN: configured, HOME: home, PATH: "" },
      repoRoot,
    });

    expect(resolved.via).toBe("nvm");
    expect(resolved.bin).toBe(pinned);
  });

  it("falls through a CODETRAIL_NODE_BIN that does not exist", async () => {
    const pinned = await writeFakeNode(nvmNode(home, "24.13.0"), "24.13.0");

    const resolved = resolveNode({
      env: {
        CODETRAIL_NODE_BIN: path.join(dir, "missing", "node"),
        HOME: home,
        PATH: "",
      },
      repoRoot,
    });

    expect(resolved.via).toBe("nvm");
    expect(resolved.bin).toBe(pinned);
  });

  it("falls back to node on PATH when the pinned version is not installed", async () => {
    await pinVersion("99.0.0");
    const onPath = await writeFakeNode(path.join(dir, "path-bin"), "24.13.0");

    const resolved = resolveNode({
      env: { HOME: home, PATH: path.join(dir, "path-bin") },
      repoRoot,
    });

    expect(resolved.via).toBe("PATH");
    expect(resolved.bin).toBe(onPath);
  });

  it("refuses a PATH node that is below the requirement", async () => {
    await pinVersion("99.0.0");
    await writeFakeNode(path.join(dir, "path-bin"), "22.21.0");

    expect(() =>
      resolveNode({
        env: { HOME: home, PATH: path.join(dir, "path-bin") },
        repoRoot,
      }),
    ).toThrow(NodeResolutionError);
  });

  it("fails with node_version_unsupported, naming every probe and the pinned version", async () => {
    await pinVersion("99.0.0");
    let caught: unknown;
    try {
      resolveNode({ env: { HOME: home, PATH: "" }, repoRoot });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NodeResolutionError);
    const error = caught as LauncherError;
    expect(error.code).toBe("node_version_unsupported");
    expect(error.message).toContain(".node-version: 99.0.0");
    expect(error.message).toContain("probed:");
    expect(error.message).toContain(".nvm");
  });

  it("probes CODETRAIL_NODE_BIN, then the pinned installs, then PATH", async () => {
    const configured = await writeFakeNode(path.join(dir, "configured"), "24.13.0");
    await writeFakeNode(nvmNode(home, "24.13.0"), "24.13.0");
    await writeFakeNode(path.join(dir, "path-bin"), "24.13.0");

    const candidates = probeCandidates({
      env: {
        CODETRAIL_NODE_BIN: configured,
        HOME: home,
        PATH: path.join(dir, "path-bin"),
      },
      repoRoot,
    });

    expect(candidates[0]).toMatchObject({ via: "CODETRAIL_NODE_BIN", bin: configured });
    expect(candidates.map((entry) => entry.via)).toContain("nvm");
    expect(candidates.at(-1)).toMatchObject({ via: "PATH" });
  });

  it("ignores a missing .node-version and still resolves from PATH", async () => {
    await rm(path.join(repoRoot, ".node-version"));
    await writeFakeNode(path.join(dir, "path-bin"), "24.13.0");

    const resolved = resolveNode({
      env: { HOME: home, PATH: path.join(dir, "path-bin") },
      repoRoot,
    });

    expect(resolved.via).toBe("PATH");
  });
});

describe("CLI", () => {
  it("prints the resolved absolute path with --print-bin and spawns nothing", async () => {
    const configured = await writeFakeNode(path.join(dir, "configured"), "24.13.0");
    const marker = path.join(dir, "marker.txt");
    const script = path.join(dir, "should-not-run.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
      "utf8",
    );

    const result = await run(["--print-bin", script], {
      CODETRAIL_NODE_BIN: configured,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${configured}\n`);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("propagates the child's exit code verbatim", async () => {
    const script = path.join(dir, "exit-seven.mjs");
    await writeFile(script, "process.exitCode = 7;\n", "utf8");

    const result = await run([script], { CODETRAIL_NODE_BIN: process.execPath });

    expect(result.code).toBe(7);
  });

  it("exits 128 + signum when the child dies from a signal", async () => {
    const script = path.join(dir, "killed.mjs");
    await writeFile(script, 'process.kill(process.pid, "SIGTERM");\n', "utf8");

    const result = await run([script], { CODETRAIL_NODE_BIN: process.execPath });

    expect(result.code).toBe(128 + 15);
  });

  it("exits non-zero with node_version_unsupported when no candidate satisfies --require", async () => {
    const result = await run(
      ["--require=>=99.0.0", path.join(dir, "noop.mjs")],
      { HOME: home, PATH: "", CODETRAIL_NODE_BIN: "" },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node_version_unsupported");
    expect(result.stderr).toContain(".node-version: 24.13.0");
  });
});

describe("package.json script table", () => {
  it("routes every script that loads repository code through the launcher", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    for (const [name, command] of Object.entries(manifest.scripts)) {
      for (const segment of command.split(/&&|\|\||;|\|/u)) {
        const tokens = segment.trim().split(/\s+/u);
        if (tokens[0] !== "node") continue;
        // No exemptions: every `node …` segment — including inline `-e`
        // snippets — must hand off to the launcher, so the whole script table
        // runs on the pinned interpreter or fails loudly. The launcher is
        // therefore the first thing after `node`, never a flag.
        expect(tokens[1], `${name} runs under the ambient interpreter`).toBe(
          "scripts/with-node.mjs",
        );
      }
    }
  });
});
