/**
 * Merge boundary: the phase B gate (issue 28) ↔ the phase-check registry and
 * the composition root (issue 27).
 *
 * Three things meet at this seam:
 *
 *   1. `scripts/phase-check.mjs` grew a `B` stage whose suite is
 *      `test/learning/phase/b-gate.test.ts`. The A stage's suite list must not
 *      move, and the CLI contract (`--simulate` can only force red, later
 *      phases are never certified while an earlier one is red) is untouched.
 *   2. `runPhase("B")` re-runs A before B, and the spawned child carries
 *      `CODETRAIL_PHASE_CHECK=1` so the B gate's own `--through=B` CLI test
 *      cannot recurse. A regression here is an infinite process tree, not a
 *      failing assertion, so it is asserted structurally.
 *   3. The A stage now includes `test/learning/api` and
 *      `test/learning/security`, whose new files spawn/read
 *      `dist/learning/api/cli.js`. The gate itself never builds, so the built
 *      composition root must ship before the gate can be green.
 *
 * Every check below is cheap: the expensive end-to-end phase runs are covered
 * by the b-gate suite itself and by `pnpm run phase:check`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const PHASE_CHECK = path.join(ROOT, "scripts", "phase-check.mjs");

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
  runPhase(
    through: string,
    options?: unknown,
  ): Promise<{
    phase: string;
    passed: boolean;
    stages: { name: string; ok: boolean; error?: string }[];
    failed?: { phase: string; stage: string; simulated?: boolean };
  }>;
}

/** A-stage suite order frozen by the gate-a issue; the B merge must not touch it. */
const A_SUITE_ORDER = [
  "check-env",
  "check-provenance",
  "fixtures",
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
];

const tempDirs: string[] = [];

function emptyRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-empty-root-"));
  tempDirs.push(dir);
  return dir;
}

async function loadPhaseCheck(): Promise<PhaseCheckModule> {
  return (await import("../../../scripts/phase-check.mjs")) as PhaseCheckModule;
}

function runPhaseCheck(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [PHASE_CHECK, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/** phase-check writes exactly one JSON object on stdout. */
function parseStdout(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("phase-check registry after the B stage merge", () => {
  test("registers A through D, keeps A's frozen suite order and points at the real gate test", async () => {
    const mod = await loadPhaseCheck();

    expect(mod.PHASES).toEqual(["A", "B", "C", "D"]);
    // Every declared phase is registered, in order, without skipping a stage.
    expect(mod.STAGES.map((stage) => stage.phase)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);

    const [stageA, stageB] = mod.STAGES;
    expect(stageA.suites.map((suite) => suite.name)).toEqual(A_SUITE_ORDER);

    expect(stageB.testFile).toBe("test/learning/phase/b-gate.test.ts");
    expect(stageB.suites.map((suite) => suite.name)).toEqual(["b-gate"]);
    expect(stageB.suites[0]).toMatchObject({
      kind: "test",
      paths: ["test/learning/phase/b-gate.test.ts"],
    });

    // Non-vacuity: every registered path exists on the integrated tree.
    for (const stage of mod.STAGES) {
      expect(
        fs.existsSync(path.join(ROOT, stage.testFile)),
        `${stage.phase} gate test must exist`,
      ).toBe(true);
      for (const suite of stage.suites) {
        for (const relative of suite.paths ?? []) {
          expect(
            fs.existsSync(path.join(ROOT, relative)),
            `${suite.name} path ${relative} must exist`,
          ).toBe(true);
        }
        if (suite.script !== undefined) {
          expect(
            fs.existsSync(path.join(ROOT, suite.script)),
            `${suite.name} script ${suite.script} must exist`,
          ).toBe(true);
        }
      }
    }
  });

  test("the B gate is skipped when phase-check spawns it, so --through=B cannot recurse", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "test/learning/phase/b-gate.test.ts"),
      "utf8",
    );
    expect(source).toContain("CODETRAIL_PHASE_CHECK");
    expect(source).toContain("describe.skipIf(INSIDE_PHASE_CHECK)");

    // The five learner-visible properties the B gate pins.
    for (const title of [
      "the reader route serves the lesson with mechanism-linked plain and technical layers",
      "three turns stay on one generation and every citation keeps its commit",
      "a genuine teardown and re-composition restores the conversation verbatim",
      "an unsupported claim is unknown, injected text is untrusted, missing background is source_missing",
      "the answer surface is exactly the five read-only tools and no write route",
    ]) {
      expect(source, `missing B-gate property: ${title}`).toContain(title);
    }
    // ...and the CLI-contract block that proves the B stage is green-able.
    expect(source).toContain("B is registered after A with its own gate test");
    expect(source).toContain("--through=C exits non-zero while B is red");
  });
});

describe("phase-check ordering and exit contracts are unchanged by the B merge", () => {
  test("checkOrder refuses to certify B while A is red, and ignores pending phases", async () => {
    const mod = await loadPhaseCheck();

    expect(
      mod.checkOrder([
        { phase: "A", passed: true, stages: [] },
        { phase: "B", passed: true, stages: [] },
      ]),
    ).toMatchObject({ ok: true, phases: ["A", "B", "C", "D"] });

    expect(
      mod.checkOrder([
        { phase: "A", passed: false, stages: [] },
        { phase: "B", passed: true, stages: [] },
      ]),
    ).toMatchObject({ ok: false, brokenBy: "A", greenWhileRed: "B" });

    expect(
      mod.checkOrder([
        { phase: "A", passed: false, stages: [] },
        { phase: "B", pending: true, stages: [] },
      ]),
    ).toEqual({ ok: false, phases: ["A", "B", "C", "D"], brokenBy: "A" });
  });

  test("runPhase('B') still runs A first and never reaches b-gate when A is simulated red", async () => {
    const mod = await loadPhaseCheck();
    const result = await mod.runPhase("B", {
      simulated: new Set(["A"]),
    });

    expect(result.phase).toBe("B");
    expect(result.passed).toBe(false);
    expect(result.failed).toMatchObject({
      phase: "A",
      stage: "simulated-fail",
      simulated: true,
    });
    expect(result.stages.map((stage) => stage.name)).toEqual([
      "simulated-fail",
    ]);
  });

  test("CLI still rejects unknown phases and cannot simulate a green phase", () => {
    const unknownPhase = runPhaseCheck(["--through=Z"]);
    expect(unknownPhase.status).toBe(2);
    expect(unknownPhase.stderr).toContain("unknown_phase Z");

    const simulatedGreen = runPhaseCheck([
      "--simulate",
      "B=pass",
      "--through=B",
    ]);
    expect(simulatedGreen.status).toBe(2);
    expect(simulatedGreen.stderr).toContain("simulate_green_forbidden B=pass");

    const conflicting = runPhaseCheck(["--verify-order", "--through=A"]);
    expect(conflicting.status).toBe(2);
    expect(conflicting.stderr).toContain("mutually exclusive");
  });

  test("B is registered but cannot run when A's preflight fails", () => {
    const result = runPhaseCheck(["--through=B", "--root", emptyRoot()]);
    expect(result.status).toBe(1);
    const json = parseStdout(result.stdout);
    expect(json.phase).toBe("B");
    expect(json.passed).toBe(false);
    expect(json.failed).toMatchObject({ phase: "A", stage: "A" });
    const stages = json.stages as { name: string; error?: string }[];
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ name: "A", ok: false });
    expect(stages[0].error).toContain("missing_gate_test");
    expect(stages.some((stage) => stage.name === "b-gate")).toBe(false);
    expect(result.stderr).toContain("phase A is red");
  });

  test("--verify-order observes every registered stage and derives red from execution", () => {
    const result = runPhaseCheck(["--verify-order", "--root", emptyRoot()]);
    expect(result.status).toBe(1);
    const json = parseStdout(result.stdout);
    expect(json.passed).toBe(false);
    const order = json.order as {
      ok: boolean;
      brokenBy?: string;
      results: { phase: string; passed?: boolean }[];
    };
    expect(order.ok).toBe(false);
    expect(order.brokenBy).toBe("A");
    expect(order.results).toEqual([
      { phase: "A", passed: false },
      { phase: "B", passed: false },
      // C and D are registered too and also fail their preflight on an empty
      // root: a registered-but-red stage is pending, never green.
      { phase: "C", passed: false },
      { phase: "D", passed: false },
    ]);
    const stages = json.stages as { name: string }[];
    expect(new Set(stages.map((stage) => stage.name))).toEqual(
      new Set(["A", "B", "C", "D"]),
    );
  });
});

describe("build dependency added by the composition root", () => {
  test("the A stage's api/security suites need the emitted composition root, and the build provides it", async () => {
    const mod = await loadPhaseCheck();
    const suites = mod.STAGES[0].suites;
    for (const name of ["api", "security"]) {
      expect(suites.some((suite) => suite.name === name)).toBe(true);
    }

    // The new files in those directories execute the built entry.
    const apiBoot = fs.readFileSync(
      path.join(ROOT, "test/learning/api/cli-boot.test.ts"),
      "utf8",
    );
    expect(apiBoot).toContain("dist/learning/api/cli.js");
    const telemetry = fs.readFileSync(
      path.join(ROOT, "test/learning/security/telemetry-off.test.ts"),
      "utf8",
    );
    expect(telemetry).toContain('"dist", "learning", "api", "cli.js"');

    // phase-check has no build stage: it relies on `pnpm run build` having run.
    expect(suites.some((suite) => suite.script === "scripts/build.mjs")).toBe(
      false,
    );

    for (const artifact of [
      "dist/cli/cli.js",
      "dist/visualize/client.js",
      "dist/visualize/styles.css",
      "dist/learning/api/cli.js",
    ]) {
      const absolute = path.join(ROOT, artifact);
      expect(fs.existsSync(absolute), `${artifact} must be built`).toBe(true);
      expect(
        fs.statSync(absolute).size,
        `${artifact} must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });
});
