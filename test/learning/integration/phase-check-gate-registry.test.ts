import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { containsTestFile } from "./merged-changes-harness.ts";

/**
 * Merge boundary: the phase-check harness (`scripts/phase-check.mjs`) ↔ the
 * merged test tree.
 *
 * `phase-check` decides AC-GATE-A and AC-GATE-ORDER by spawning the suites it
 * registers. A merge that moves, renames or deletes a suite must not leave the
 * gate green by making its own registry stale: the script preflights every
 * declared path, and an empty directory is a red gate. This suite asserts that
 * registry resolves on the *integrated* tree and that the CLI contract
 * (`--simulate` can only force red) still holds.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface StageSuite {
  name: string;
  kind: "test" | "script";
  paths?: string[];
  script?: string;
}

interface Stage {
  phase: string;
  testFile: string;
  suites: StageSuite[];
}

interface PhaseCheckModule {
  PHASES: string[];
  STAGES: Stage[];
  checkOrder(results: unknown[]): Record<string, unknown>;
  runPhase(through: string, options?: unknown): Promise<unknown>;
  verifyOrder(options?: unknown): Promise<unknown>;
}

async function loadPhaseCheck(): Promise<PhaseCheckModule> {
  return (await import("../../../scripts/phase-check.mjs")) as PhaseCheckModule;
}

describe("phase-check gate registry on the integrated tree", () => {
  it("registers A through D in the frozen order, each with an existing gate test", async () => {
    const mod = await loadPhaseCheck();

    expect(mod.PHASES).toEqual(["A", "B", "C", "D"]);
    // Every phase in PHASES is registered, in order, without skipping a stage.
    expect(mod.STAGES.map((stage) => stage.phase)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);

    const stageB = mod.STAGES[1];
    expect(stageB.testFile).toBe("test/learning/phase/b-gate.test.ts");
    expect(stageB.suites.map((suite) => suite.name)).toEqual(["b-gate"]);
    expect(fs.existsSync(path.join(ROOT, stageB.testFile))).toBe(true);

    const stageA = mod.STAGES[0];
    expect(fs.existsSync(path.join(ROOT, stageA.testFile))).toBe(true);
    expect(
      stageA.suites.some((suite) => suite.paths?.includes(stageA.testFile)),
      "the gate test is itself a registered suite (an empty pass is impossible)",
    ).toBe(true);

    const names = new Set(stageA.suites.map((suite) => suite.name));
    for (const required of [
      "check-env",
      "check-provenance",
      "contracts-leaf",
      "architecture",
      "environment",
      "fork",
      "store",
      "projects",
      "upstream",
      "lessons",
      "retrieval",
      "generation",
      "api",
      "security",
      "ops",
      "a-gate",
    ]) {
      expect(names.has(required), `missing required A suite: ${required}`).toBe(
        true,
      );
    }
  });

  it("points every declared script and suite at a runnable target", async () => {
    const mod = await loadPhaseCheck();
    const stageA = mod.STAGES[0];

    for (const suite of stageA.suites) {
      if (suite.kind === "script") {
        expect(suite.script, `${suite.name} names a script`).toBeTruthy();
        expect(
          fs.existsSync(path.join(ROOT, suite.script!)),
          `missing script for ${suite.name}: ${suite.script}`,
        ).toBe(true);
        continue;
      }
      expect(suite.paths?.length ?? 0).toBeGreaterThan(0);
      for (const relative of suite.paths!) {
        const absolute = path.join(ROOT, relative);
        expect(fs.existsSync(absolute), `missing suite path: ${relative}`).toBe(
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
  });

  it("keeps the merged changes suites inside the api stage", async () => {
    const mod = await loadPhaseCheck();
    const apiStage = mod.STAGES[0].suites.find((suite) => suite.name === "api");
    expect(apiStage).toBeDefined();

    for (const merged of [
      "changes-pagination.test.ts",
      "changes-watch.test.ts",
      "route-allowlist.test.ts",
    ]) {
      const absolute = path.join(ROOT, "test/learning/api", merged);
      expect(
        fs.existsSync(absolute),
        `merged api test missing: ${merged}`,
      ).toBe(true);
    }
  });
});

describe("phase-check ordering semantics", () => {
  it("rejects a later green phase while an earlier one is red", async () => {
    const mod = await loadPhaseCheck();

    const redThenGreen = mod.checkOrder([
      { phase: "A", passed: false, stages: [] },
      { phase: "B", passed: true, stages: [] },
    ]);
    expect(redThenGreen).toMatchObject({
      ok: false,
      brokenBy: "A",
      greenWhileRed: "B",
    });

    const redThenPending = mod.checkOrder([
      { phase: "A", passed: false, stages: [] },
      { phase: "B", pending: true, stages: [] },
    ]);
    expect(redThenPending).toMatchObject({ ok: false, brokenBy: "A" });

    const greenThenPending = mod.checkOrder([
      { phase: "A", passed: true, stages: [] },
      { phase: "B", pending: true, stages: [] },
    ]);
    expect(greenThenPending).toMatchObject({ ok: true });
  });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runPhaseCheck(args: string[]): CliRun {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts/phase-check.mjs"), ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("phase-check CLI contract", () => {
  it("can only be forced red, and reports it as JSON", () => {
    const result = runPhaseCheck(["--through=A", "--simulate", "A=fail"]);

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      phase: string;
      passed: boolean;
      failed: { simulated?: boolean; phase: string };
    };
    expect(parsed.phase).toBe("A");
    expect(parsed.passed).toBe(false);
    expect(parsed.failed).toMatchObject({ phase: "A", simulated: true });
    expect(result.stderr).toContain("simulated");
  });

  it("refuses a simulation that would manufacture a pass", () => {
    const result = runPhaseCheck(["--through=A", "--simulate", "A=pass"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("simulate_green_forbidden");
    expect(result.stdout).toBe("");
  });

  it("rejects mutually exclusive or unknown arguments", () => {
    const exclusive = runPhaseCheck(["--through=A", "--verify-order"]);
    expect(exclusive.status).toBe(2);
    expect(exclusive.stderr).toContain("mutually exclusive");

    const unknown = runPhaseCheck(["--nonsense"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown argument");
  });
});
