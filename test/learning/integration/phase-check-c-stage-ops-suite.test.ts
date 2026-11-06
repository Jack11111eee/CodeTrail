/**
 * Integration merge boundary: gate-c (`scripts/phase-check.mjs`) × ops-scripts
 * (`test/learning/ops`, `scripts/*.mjs`).
 *
 * The two merged branches meet in the phase-gate registry:
 *   - gate-c appends the C stage (`updates` + `c-gate`) to the same frozen
 *     `STAGES` array that already contains A and B;
 *   - ops-scripts grows `test/learning/ops` from one suite into ten files and
 *     adds the operator scripts that A registers (`check-env`,
 *     `check-provenance`).
 *
 * A clean textual merge can still regress this boundary: a C entry that
 * replaces rather than appends, an A entry whose `ops` directory no longer
 * contains the new tests, or a C preflight that passes vacuously when the
 * `updates` suite disappears. These tests exercise the real registry on the
 * integrated tree and drive the real CLI against a throwaway `--root` so no
 * multi-minute suite is spawned.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const PHASE_CHECK = path.join(ROOT, "scripts", "phase-check.mjs");

interface SuiteSeam {
  name: string;
  kind: string;
  paths: string[];
  script: string | null;
}

interface StageSeam {
  phase: string;
  testFile: string;
  suites: SuiteSeam[];
}

interface PhaseCheckModule {
  PHASES: string[];
  STAGES: StageSeam[];
  checkOrder(results: unknown[]): Record<string, unknown>;
}

async function loadPhaseCheck(): Promise<PhaseCheckModule> {
  return (await import(PHASE_CHECK)) as PhaseCheckModule;
}

/** True when a directory contains at least one `*.test.ts` file, recursively. */
function containsTestFile(directory: string): boolean {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (containsTestFile(absolute)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}

/**
 * A throwaway tree that satisfies preflight for every registered suite without
 * running a real test. `scripts/with-node.mjs` exits 0 immediately, so a
 * `kind:"test"` suite is a no-op; script suites are no-ops too.
 *
 * The `--root` seam mirrors the real registry, which is what makes the C
 * preflight non-vacuity assertion below meaningful.
 */
function createStubRoot(stages: StageSeam[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-c-registry-"));
  const write = (relative: string, content: string): void => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  };
  write("scripts/with-node.mjs", "process.exit(0);\n");
  for (const stage of stages) {
    write(stage.testFile, "export {};\n");
    for (const suite of stage.suites) {
      if (suite.kind === "script") {
        write(suite.script!, "process.exit(0);\n");
        continue;
      }
      for (const relative of suite.paths) {
        write(
          relative.endsWith(".test.ts")
            ? relative
            : path.join(relative, "stub.test.ts"),
          "export {};\n",
        );
      }
    }
  }
  return root;
}

function runPhaseCheck(
  args: string[],
  timeoutMs = 60_000,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [PHASE_CHECK, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function parsedStdout(result: ReturnType<typeof spawnSync>): Record<
  string,
  unknown
> {
  expect(typeof result.stdout, "phase-check writes one JSON object").toBe(
    "string",
  );
  return JSON.parse(String(result.stdout).trim()) as Record<string, unknown>;
}

const tempRoots: string[] = [];
let module: PhaseCheckModule;

beforeAll(async () => {
  module = await loadPhaseCheck();
});

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("phase-check registry: gate-c C stage on the merged tree", () => {
  test("C is appended after the merged A and B stages and keeps ops inside A", () => {
    expect(module.PHASES).toEqual(["A", "B", "C", "D"]);
    expect(module.STAGES.map((stage) => stage.phase)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);

    const [stageA, stageB, stageC] = module.STAGES;

    // gate-c appended C; it did not rewrite the A or B entries.
    expect(stageA.testFile).toBe("test/learning/phase/a-gate.test.ts");
    expect(stageB.testFile).toBe("test/learning/phase/b-gate.test.ts");
    expect(stageC.testFile).toBe("test/learning/phase/c-gate.test.ts");

    expect(stageC.suites.map((suite) => suite.name)).toEqual([
      "updates",
      "c-gate",
    ]);
    expect(stageC.suites[0].paths).toEqual(["test/learning/updates"]);
    expect(stageC.suites[1].paths).toEqual([
      "test/learning/phase/c-gate.test.ts",
    ]);

    // ops-scripts' new tests live inside the suite the A stage registers.
    const opsSuite = stageA.suites.find((suite) => suite.name === "ops");
    expect(opsSuite, "A still registers the ops suite").toBeDefined();
    expect(opsSuite!.paths).toEqual(["test/learning/ops"]);

    for (const file of [
      "accept.test.ts",
      "backup-restore.test.ts",
      "gc.test.ts",
      "licenses.test.ts",
      "logs.test.ts",
      "smoke.test.ts",
      "data-dir-boundary.test.ts",
    ]) {
      expect(
        fs.existsSync(path.join(ROOT, "test/learning/ops", file)),
        `ops-scripts test missing from the A stage directory: ${file}`,
      ).toBe(true);
    }
  });

  test("every suite the merged registry declares resolves on disk", () => {
    for (const stage of module.STAGES) {
      expect(
        fs.existsSync(path.join(ROOT, stage.testFile)),
        `missing gate test for ${stage.phase}: ${stage.testFile}`,
      ).toBe(true);

      for (const suite of stage.suites) {
        if (suite.kind === "script") {
          expect(suite.script, `${suite.name} must name a script`).toBeTruthy();
          expect(
            fs.existsSync(path.join(ROOT, suite.script!)),
            `missing script for ${suite.name}: ${suite.script}`,
          ).toBe(true);
          continue;
        }

        expect(
          suite.paths.length,
          `${suite.name} must declare at least one path`,
        ).toBeGreaterThan(0);

        for (const relative of suite.paths) {
          const absolute = path.join(ROOT, relative);
          expect(fs.existsSync(absolute), `missing suite: ${relative}`).toBe(
            true,
          );
          const stat = fs.lstatSync(absolute);
          if (stat.isDirectory()) {
            expect(
              containsTestFile(absolute),
              `empty suite directory: ${relative}`,
            ).toBe(true);
          }
        }
      }
    }
  }, 60_000);

  test("--through=C composes A, B and C from the merged registry and is green", () => {
    const root = createStubRoot(module.STAGES);
    tempRoots.push(root);

    const result = runPhaseCheck(["--through=C", "--root", root]);
    expect(result.status, String(result.stderr)).toBe(0);

    const json = parsedStdout(result);
    expect(json.phase).toBe("C");
    expect(json.passed).toBe(true);
    expect(json.order).toMatchObject({ ok: true });

    const stages = json.stages as { name: string; ok: boolean }[];
    const names = stages.map((stage) => stage.name);
    for (const required of ["a-gate", "b-gate", "updates", "c-gate"]) {
      expect(names, `C chain is missing ${required}`).toContain(required);
      expect(
        stages.find((stage) => stage.name === required)?.ok,
        `${required} did not pass`,
      ).toBe(true);
    }
    expect(names.indexOf("a-gate")).toBeLessThan(names.indexOf("b-gate"));
    expect(names.indexOf("b-gate")).toBeLessThan(names.indexOf("updates"));
    expect(names.indexOf("updates")).toBeLessThan(names.indexOf("c-gate"));

    // gate-c's own regression: a red C blocks D.
    const order = module.checkOrder([
      { phase: "A", passed: true },
      { phase: "B", passed: true },
      { phase: "C", passed: false },
      { phase: "D", pending: true },
    ]);
    expect(order).toMatchObject({ ok: false, brokenBy: "C" });
    expect(order).not.toHaveProperty("greenWhileRed");
  }, 120_000);

  test("C preflight fails when the merged updates suite is missing (not vacuous)", () => {
    const root = createStubRoot(module.STAGES);
    tempRoots.push(root);
    fs.rmSync(path.join(root, "test", "learning", "updates"), {
      recursive: true,
      force: true,
    });

    const result = runPhaseCheck(["--through=C", "--root", root]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.phase).toBe("C");
    expect(json.passed).toBe(false);
    expect(json.failed).toMatchObject({ phase: "C", stage: "updates" });
    const stages = json.stages as { name: string; error?: string }[];
    expect(stages.some((stage) => stage.name === "updates")).toBe(true);
    const error = stages.find((stage) => stage.name === "updates")?.error ?? "";
    expect(error).toMatch(/missing_suite|empty_suite/u);
  }, 120_000);

  test("--through=D stays red while C is simulated red", () => {
    const root = createStubRoot(module.STAGES);
    tempRoots.push(root);

    const result = runPhaseCheck([
      "--through=D",
      "--simulate",
      "C=fail",
      "--root",
      root,
    ]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.phase).toBe("D");
    expect(json.passed).toBe(false);
    expect(json.failed).toMatchObject({ phase: "C", simulated: true });
    expect(String(result.stderr)).toContain("phase C is red");
  }, 120_000);
});
