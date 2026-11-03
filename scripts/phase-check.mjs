#!/usr/bin/env node
/**
 * Phase gates for the learning system (architecture §18, §21 invariant 4).
 *
 *   node scripts/phase-check.mjs [--through=A|B|C|D] [--verify-order]
 *                                [--simulate <PHASE>=fail] [--root <dir>]
 *
 * The script is the single verdict for AC-GATE-A and AC-GATE-ORDER. It must
 * also run on the ambient interpreter (before `pnpm install` and before the
 * learning toolchain is known to exist), so it imports nothing but `node:`
 * builtins. Child suites are spawned through `scripts/with-node.mjs`, which is
 * what pins the runtime.
 *
 * Output contract:
 *   stdout  one JSON object, never logs:
 *           {"phase":"A","passed":true,
 *            "stages":[{"name","ok","command","error?"}],
 *            "order":{"ok":true,"phases":["A","B","C","D"]}}
 *   stderr  every child's output plus a human-readable failure line.
 *
 * Every verdict is a spawned command or a filesystem assertion. There is no
 * declared "passed" list: `--verify-order` derives pass state by running each
 * registered stage. A stage whose suite path is missing, whose gate test is
 * absent, or whose required names were edited away fails before anything is
 * spawned, so an empty (vacuous) pass is impossible.
 *
 * `--simulate <PHASE>=fail` is the only way to change a verdict before running
 * it, and it can only force red. `=pass` is rejected: a simulation must never
 * be able to make a gate green.
 *
 * Later issues append one entry to `STAGES` and add their `b-gate.test.ts`
 * (etc.). They do not touch the CLI, the exit codes or `verifyOrder`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Canonical phase order. Every stage must be one of these ids. */
export const PHASES = Object.freeze(["A", "B", "C", "D"]);

const USAGE = `usage: node scripts/phase-check.mjs [--through=A|B|C|D] [--verify-order] [--simulate <PHASE>=fail] [--root <dir>]
`;

/** The vitest runner the suites are invoked with (architecture §18). */
const VITEST = path.join("node_modules", "vitest", "vitest.mjs");
const VITEST_CONFIG = "vitest.learning.config.ts";

/** One suite may take minutes on a loaded machine; never hang forever. */
const SUITE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The A stage: waves 0a–3d (architecture §21). `contracts-leaf` is named
 * separately because invariant 0 pins it; the remaining architecture files are
 * their own suite.
 *
 * These names are also the non-vacuity contract: `REQUIRED_SUITES` below fails
 * the gate if any of them is edited away.
 */
const A_SUITES = Object.freeze([
  Object.freeze({
    name: "contracts-leaf",
    kind: "test",
    paths: Object.freeze(["test/learning/architecture/contracts-leaf.test.ts"]),
  }),
  Object.freeze({
    name: "architecture",
    kind: "test",
    paths: Object.freeze([
      "test/learning/architecture/dom-boundary.test.ts",
      "test/learning/architecture/upstream-boundary.test.ts",
    ]),
  }),
  Object.freeze({
    name: "environment",
    kind: "test",
    paths: Object.freeze(["test/learning/environment"]),
  }),
  Object.freeze({
    name: "fork",
    kind: "test",
    paths: Object.freeze(["test/learning/fork"]),
  }),
  Object.freeze({
    name: "store",
    kind: "test",
    paths: Object.freeze(["test/learning/store"]),
  }),
  Object.freeze({
    name: "projects",
    kind: "test",
    paths: Object.freeze(["test/learning/projects"]),
  }),
  Object.freeze({
    name: "upstream",
    kind: "test",
    paths: Object.freeze(["test/learning/upstream"]),
  }),
  Object.freeze({
    name: "lessons",
    kind: "test",
    paths: Object.freeze(["test/learning/lessons"]),
  }),
  Object.freeze({
    name: "retrieval",
    kind: "test",
    paths: Object.freeze(["test/learning/retrieval"]),
  }),
  Object.freeze({
    name: "generation",
    kind: "test",
    paths: Object.freeze(["test/learning/generation"]),
  }),
  Object.freeze({
    name: "api",
    kind: "test",
    paths: Object.freeze(["test/learning/api"]),
  }),
  Object.freeze({
    name: "security",
    kind: "test",
    paths: Object.freeze(["test/learning/security"]),
  }),
  Object.freeze({
    name: "ops",
    kind: "test",
    paths: Object.freeze(["test/learning/ops"]),
  }),
]);

/**
 * The B stage: waves 4a–4d (architecture §21). Phase B is the learner-visible
 * half of the product — a published Chinese lesson, continuous follow-ups, a
 * restart-safe conversation and a read-only answer surface — so its single gate
 * test drives the production server instead of unit-testing the pieces. A's
 * suites are re-run by `runPhase("B")` above; they are not duplicated here.
 */
const B_SUITES = Object.freeze([
  Object.freeze({
    name: "b-gate",
    kind: "test",
    paths: Object.freeze(["test/learning/phase/b-gate.test.ts"]),
  }),
]);

/**
 * The C stage: waves 5a–5b (architecture §21 invariant 4). Phase C is change
 * follow-up, so the stage runs the whole updates suite (discovery, cursors,
 * diffs, linkage) and then the single gate test that drives the watch tick
 * against the fake GitHub server and the `watch-remote` fixture. A's and B's
 * suites are re-run by `runPhase("C")` above; they are not duplicated here.
 */
const C_SUITES = Object.freeze([
  Object.freeze({
    name: "updates",
    kind: "test",
    paths: Object.freeze(["test/learning/updates"]),
  }),
  Object.freeze({
    name: "c-gate",
    kind: "test",
    paths: Object.freeze(["test/learning/phase/c-gate.test.ts"]),
  }),
]);

/**
 * The stage registry. B/C/D append one frozen entry each; A is owned by the
 * gate-a issue and nobody else touches it.
 *
 * A `suite` is either `{kind:"test", paths}` (one vitest invocation) or
 * `{kind:"script", script, args}` (a dependency-free check such as
 * `check-env.mjs`). `testFile` is the phase's own gate test.
 */
export const STAGES = Object.freeze([
  Object.freeze({
    phase: "A",
    testFile: "test/learning/phase/a-gate.test.ts",
    suites: Object.freeze([
      Object.freeze({
        name: "check-env",
        kind: "script",
        script: "scripts/check-env.mjs",
        args: Object.freeze([]),
      }),
      Object.freeze({
        name: "check-provenance",
        kind: "script",
        script: "scripts/check-provenance.mjs",
        args: Object.freeze([]),
      }),
      // The fixtures are deterministic test inputs, not a verdict; building
      // them inside the gate keeps `phase:check` self-sufficient on a clean
      // checkout. A fixture failure is still a red A stage.
      Object.freeze({
        name: "fixtures",
        kind: "script",
        script: "scripts/make-fixtures.mjs",
        args: Object.freeze([]),
        // Rebuilding a fixture tree that already exists would race with any
        // suite that is reading it. Build only on a clean checkout.
        skipIfExists: ".tmp/fixtures/manifest.json",
      }),
      ...A_SUITES,
      Object.freeze({
        name: "a-gate",
        kind: "test",
        paths: Object.freeze(["test/learning/phase/a-gate.test.ts"]),
      }),
    ]),
  }),
  Object.freeze({
    phase: "B",
    testFile: "test/learning/phase/b-gate.test.ts",
    suites: B_SUITES,
  }),
  Object.freeze({
    phase: "C",
    testFile: "test/learning/phase/c-gate.test.ts",
    suites: C_SUITES,
  }),
]);

/** Names each stage must keep; deleting one is a red gate, not a green one. */
const REQUIRED_SUITES = Object.freeze({
  A: Object.freeze([
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
  ]),
  B: Object.freeze(["b-gate"]),
  C: Object.freeze(["updates", "c-gate"]),
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.lstatSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** True when a directory tree contains at least one `*.test.ts` file. */
function containsTestFile(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (containsTestFile(absolute)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}

/** A readable, cwd-independent description of what a suite runs. */
function describeSuite(suite) {
  if (suite.kind === "script") {
    return ["node", suite.script, ...(suite.args ?? [])].join(" ");
  }
  return [
    "node",
    path.join("scripts", "with-node.mjs"),
    VITEST,
    "run",
    "--config",
    VITEST_CONFIG,
    // The config's 30s default is tight on a loaded machine; the generation
    // suite is documented to need 120s as well.
    "--testTimeout=120000",
    "--hookTimeout=120000",
    ...suite.paths,
  ].join(" ");
}

/**
 * Fails a stage before any child runs when a prerequisite is missing. `null`
 * means the suite is runnable.
 */
function preflightSuite(suite, root) {
  if (!isPlainObject(suite) || typeof suite.name !== "string") {
    return "invalid_suite_entry";
  }
  if (suite.kind === "script") {
    if (typeof suite.script !== "string" || suite.script === "") {
      return `missing_script ${suite.name}`;
    }
    if (!exists(path.join(root, suite.script))) {
      return `missing_script ${suite.script}`;
    }
    return null;
  }
  if (suite.kind !== "test") {
    return `invalid_suite_kind ${String(suite.kind)}`;
  }
  if (!Array.isArray(suite.paths) || suite.paths.length === 0) {
    return `missing_suite_path ${suite.name}`;
  }
  for (const relative of suite.paths) {
    const absolute = path.join(root, relative);
    if (!exists(absolute)) {
      return `missing_suite ${relative}`;
    }
    if (isDirectory(absolute) && !containsTestFile(absolute)) {
      return `empty_suite ${relative}`;
    }
  }
  return null;
}

function preflightStage(stage, root) {
  if (typeof stage.testFile !== "string" || stage.testFile === "") {
    return { name: stage.phase, error: `missing_gate_test ${stage.phase}` };
  }
  if (!exists(path.join(root, stage.testFile))) {
    return { name: stage.phase, error: `missing_gate_test ${stage.testFile}` };
  }

  const names = new Set(stage.suites.map((suite) => suite.name));
  for (const required of REQUIRED_SUITES[stage.phase] ?? []) {
    if (!names.has(required)) {
      return { name: stage.phase, error: `missing_required_suite ${required}` };
    }
  }

  for (const suite of stage.suites) {
    const problem = preflightSuite(suite, root);
    if (problem !== null) return { name: suite.name, error: problem };
  }
  return null;
}

function childEnvironment(phase) {
  return {
    ...process.env,
    // The gate test skips its own CLI-contract block when it is executed from
    // inside phase-check; otherwise `--through=A` would spawn itself forever.
    CODETRAIL_PHASE_CHECK: "1",
    CODETRAIL_PHASE_CHECK_PHASE: phase,
  };
}

function runSuite(suite, stage, root) {
  const args =
    suite.kind === "script"
      ? [path.join(root, suite.script), ...(suite.args ?? [])]
      : [
          path.join(root, "scripts", "with-node.mjs"),
          path.join(root, VITEST),
          "run",
          "--config",
          path.join(root, VITEST_CONFIG),
          "--testTimeout=120000",
          "--hookTimeout=120000",
          ...suite.paths,
        ];

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: childEnvironment(stage.phase),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SUITE_TIMEOUT_MS,
    windowsHide: true,
  });

  // Child output is diagnostics, never the verdict: keep stdout parseable.
  if (typeof result.stdout === "string" && result.stdout !== "") {
    process.stderr.write(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr !== "") {
    process.stderr.write(result.stderr);
  }

  if (result.error !== undefined && result.error !== null) {
    const timedOut = result.error.code === "ETIMEDOUT";
    return {
      name: suite.name,
      ok: false,
      command: describeSuite(suite),
      error: timedOut
        ? `timeout after ${SUITE_TIMEOUT_MS}ms`
        : `spawn_error ${result.error.message}`,
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return {
      name: suite.name,
      ok: false,
      command: describeSuite(suite),
      error: `terminated_by_signal ${result.signal}`,
    };
  }
  if (result.status !== 0) {
    return {
      name: suite.name,
      ok: false,
      command: describeSuite(suite),
      error: `exit_code ${result.status}`,
    };
  }
  return { name: suite.name, ok: true, command: describeSuite(suite) };
}

/**
 * Runs one phase. Stops at the first red suite; nothing later in the phase or
 * the chain runs. `simulated` can only force this phase red.
 */
async function runStage(stage, options) {
  const root = options.root;
  const simulated = options.simulated;

  if (simulated.has(stage.phase)) {
    return {
      phase: stage.phase,
      passed: false,
      simulated: true,
      failedStage: "simulated-fail",
      stages: [
        {
          name: "simulated-fail",
          ok: false,
          command: "(simulated)",
          error: `simulated_fail ${stage.phase}`,
        },
      ],
    };
  }

  const blocked = preflightStage(stage, root);
  if (blocked !== null) {
    return {
      phase: stage.phase,
      passed: false,
      failedStage: blocked.name,
      stages: [
        {
          name: blocked.name,
          ok: false,
          command: stage.suites.find((suite) => suite.name === blocked.name)
            ? describeSuite(
                stage.suites.find((suite) => suite.name === blocked.name),
              )
            : "(preflight)",
          error: blocked.error,
        },
      ],
    };
  }

  const stages = [];
  for (const suite of stage.suites) {
    if (
      typeof suite.skipIfExists === "string" &&
      exists(path.join(root, suite.skipIfExists))
    ) {
      stages.push({
        name: suite.name,
        ok: true,
        command: describeSuite(suite),
        note: "already_present",
      });
      continue;
    }
    const entry = runSuite(suite, stage, root);
    stages.push(entry);
    if (!entry.ok) {
      return {
        phase: stage.phase,
        passed: false,
        failedStage: entry.name,
        stages,
      };
    }
  }
  return { phase: stage.phase, passed: true, stages };
}

/**
 * The ordering invariant: a later phase may never be green while an earlier
 * one is red. `pending` entries (unregistered phases) are neither green nor
 * red, so they cannot certify anything.
 *
 * Exported for the gate test, which proves the green-after-red case directly
 * because a real run stops before it can happen.
 */
export function checkOrder(results) {
  let firstRed = null;
  for (const result of results) {
    if (result.pending === true) continue;
    if (result.passed !== true && firstRed === null) firstRed = result.phase;
    if (result.passed === true && firstRed !== null) {
      return {
        ok: false,
        phases: [...PHASES],
        brokenBy: firstRed,
        greenWhileRed: result.phase,
      };
    }
  }
  return firstRed === null
    ? { ok: true, phases: [...PHASES] }
    : { ok: false, phases: [...PHASES], brokenBy: firstRed };
}

function flattenStages(results) {
  const stages = [];
  for (const result of results) {
    for (const stage of result.stages ?? []) stages.push(stage);
  }
  return stages;
}

/**
 * Accepts either `{simulated, root}` (what `main` passes) or a bare
 * `Set<PhaseId>` (the shape the issue contract names for `verifyOrder`), so a
 * later gate can import and call the runner without guessing.
 */
function optionsOf(value) {
  if (value instanceof Set) return { simulated: value };
  if (isPlainObject(value)) return value;
  return {};
}

/**
 * Runs A…`through`. Unregistered phases fail loudly (`phase_not_registered`)
 * instead of being treated as green, which is what makes `--through=B` red
 * while A is red and B does not exist yet.
 */
export async function runPhase(through, options = {}) {
  const opts = optionsOf(options);
  const root = opts.root ?? SCRIPT_ROOT;
  const simulated = opts.simulated ?? new Set();
  const target = PHASES.indexOf(through);

  const results = [];
  for (let index = 0; index <= target; index += 1) {
    const phase = PHASES[index];
    const stage = STAGES.find((candidate) => candidate.phase === phase);
    if (stage === undefined) {
      results.push({ phase, passed: false, pending: true, stages: [] });
      const order = checkOrder(results);
      return {
        phase: through,
        passed: false,
        stages: flattenStages(results),
        order,
        failed: { phase, stage: "phase_not_registered" },
        error: `phase_not_registered ${phase}`,
      };
    }

    const result = await runStage(stage, { root, simulated });
    results.push(result);
    if (!result.passed) {
      const order = checkOrder(results);
      return {
        phase: through,
        passed: false,
        stages: flattenStages(results),
        order,
        failed: {
          phase: result.phase,
          stage: result.failedStage ?? "unknown",
          ...(result.simulated === true ? { simulated: true } : {}),
        },
      };
    }
  }

  return {
    phase: through,
    passed: true,
    stages: flattenStages(results),
    order: checkOrder(results),
  };
}

/**
 * Derives every registered phase's pass state by running it — never from a
 * declared list — and then checks the ordering invariant. A red phase blocks
 * nothing from being *observed*: later phases still run, so a gate that is
 * green while A is red is detected rather than hidden.
 */
export async function verifyOrder(options = {}) {
  const opts = optionsOf(options);
  const root = opts.root ?? SCRIPT_ROOT;
  const simulated = opts.simulated ?? new Set();

  const results = [];
  for (const phase of PHASES) {
    const stage = STAGES.find((candidate) => candidate.phase === phase);
    if (stage === undefined) {
      results.push({ phase, passed: false, pending: true, stages: [] });
      continue;
    }
    results.push(await runStage(stage, { root, simulated }));
  }

  const order = checkOrder(results);
  const red = results.find(
    (result) => result.pending !== true && result.passed !== true,
  );
  return {
    phase: red?.phase ?? null,
    passed: order.ok,
    stages: flattenStages(results),
    order: {
      ...order,
      results: results.map((result) => ({
        phase: result.phase,
        ...(result.pending === true
          ? { pending: true }
          : { passed: result.passed === true }),
      })),
    },
  };
}

function parseSimulation(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--simulate expects <PHASE>=fail, got: ${value}`);
  }
  const phase = value.slice(0, separator).trim().toUpperCase();
  const verdict = value
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  if (!PHASES.includes(phase)) {
    throw new Error(`unknown phase in --simulate: ${phase}`);
  }
  if (verdict !== "fail") {
    // Red-only by construction: a simulation must never manufacture a pass.
    throw new Error(`simulate_green_forbidden ${phase}=${verdict}`);
  }
  return phase;
}

function parseArgs(argv) {
  const options = {
    through: null,
    verifyOrder: false,
    simulated: new Set(),
    root: SCRIPT_ROOT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--through") {
      const value = argv[index + 1];
      if (!value) throw new Error("--through requires a phase");
      options.through = value;
      index += 1;
    } else if (arg.startsWith("--through=")) {
      options.through = arg.slice("--through=".length);
    } else if (arg === "--verify-order") {
      options.verifyOrder = true;
    } else if (arg === "--simulate") {
      const value = argv[index + 1];
      if (!value) throw new Error("--simulate requires <PHASE>=fail");
      options.simulated.add(parseSimulation(value));
      index += 1;
    } else if (arg.startsWith("--simulate=")) {
      options.simulated.add(parseSimulation(arg.slice("--simulate=".length)));
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory");
      options.root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length);
      if (!value) throw new Error("--root requires a directory");
      options.root = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.verifyOrder && options.through !== null) {
    throw new Error("--through and --verify-order are mutually exclusive");
  }
  if (options.through === null) {
    // The package script is useful bare; A is the base every later gate needs.
    options.through = "A";
  }
  if (!PHASES.includes(options.through)) {
    throw new Error(`unknown_phase ${options.through}`);
  }
  return options;
}

function failureLine(result, verifyOrderMode) {
  if (verifyOrderMode) {
    if (result.order?.greenWhileRed !== undefined) {
      return `verify-order failed: phase ${result.order.greenWhileRed} is green while ${result.order.brokenBy} is red`;
    }
    if (result.order?.brokenBy !== undefined) {
      return `verify-order failed: phase ${result.order.brokenBy} is red; later phases cannot be certified`;
    }
    return "verify-order failed";
  }
  const failed = result.failed;
  if (failed === undefined) return `phase ${result.phase} failed`;
  if (failed.stage === "phase_not_registered") {
    return `phase ${failed.phase} is not registered`;
  }
  if (failed.simulated === true) {
    return `phase ${failed.phase} is red at ${failed.stage} (simulated)`;
  }
  const entry = result.stages?.find((stage) => stage.name === failed.stage);
  return `phase ${failed.phase} is red at ${failed.stage}${
    typeof entry?.error === "string" ? `: ${entry.error}` : ""
  }`;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`phase-check: ${error.message}\n${USAGE}`);
    return 2;
  }

  if (options.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  let result;
  try {
    result = options.verifyOrder
      ? await verifyOrder({ root: options.root, simulated: options.simulated })
      : await runPhase(options.through, {
          root: options.root,
          simulated: options.simulated,
        });
  } catch (error) {
    process.stderr.write(
      `phase-check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.passed === true) return 0;
  process.stderr.write(`${failureLine(result, options.verifyOrder)}\n`);
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `phase-check: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
