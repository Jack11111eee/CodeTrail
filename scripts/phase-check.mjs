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

/** Where the regression categories and the acceptance matrix live (§21). */
const REGRESSION_DIR = "test/learning/regression";
const ACCEPTANCE_DIR = "test/learning/acceptance";
/** The canonical R01…R17 and F01…F10 counts AC-GATE-D pins (Appendix A.13/A.14). */
const EXPECTED_REGRESSION_GROUPS = 17;
const EXPECTED_ACCEPTANCE_FLOWS = 10;
/** The canonical registry the per-file expectations are read from. */
const AC_REGISTRY_FILE = `${ACCEPTANCE_DIR}/ac-registry.ts`;

/**
 * The D stage: waves 6a–6b plus every regression and acceptance suite
 * (architecture §21 invariant 4). Phase D is the release verdict, so it runs
 * the whole regression set and the acceptance matrix before its own gate test.
 *
 * The two directory entries are globbed by the runner (`*.test.ts` inside
 * them), so a suite added or removed on disk is picked up without editing this
 * table; the counts printed in the D result are measured from the filesystem
 * by {@link measureGateCounts}, never declared.
 *
 * The acceptance flows boot the built server (one or more node processes plus
 * Git each), so they are capped to a few workers: seven-at-once starves the
 * box and turns a correct flow into a timeout on a loaded machine.
 */
const D_SUITES = Object.freeze([
  Object.freeze({
    name: "regression",
    kind: "test",
    paths: Object.freeze([REGRESSION_DIR]),
  }),
  Object.freeze({
    name: "acceptance",
    kind: "test",
    paths: Object.freeze([ACCEPTANCE_DIR]),
    args: Object.freeze(["--maxWorkers=3"]),
  }),
  Object.freeze({
    name: "d-gate",
    kind: "test",
    paths: Object.freeze(["test/learning/phase/d-gate.test.ts"]),
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
  Object.freeze({
    phase: "D",
    testFile: "test/learning/phase/d-gate.test.ts",
    suites: D_SUITES,
    // The expected counts, not the measured ones: `runStage` globs the
    // filesystem and fails the stage when it does not match these.
    counts: Object.freeze({
      regressions: EXPECTED_REGRESSION_GROUPS,
      matrix: EXPECTED_ACCEPTANCE_FLOWS,
    }),
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
  D: Object.freeze(["regression", "acceptance", "d-gate"]),
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

/** The regular files directly inside `directory`, sorted; `[]` when absent. */
function fileNames(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

const REGRESSION_FILE = /^r(\d{2})-[^/]+\.test\.ts$/u;
const ACCEPTANCE_FILE = /^f(\d{2})-[^/]+\.test\.ts$/u;
/** `.only(` and `.skip(` silence a suite; `.skipIf(` is a conditional guard. */
const SKIP_CALL = /\.(?:only|skip)\s*\(/u;

function missingIds(present, expected) {
  const missing = [];
  for (let index = 1; index <= expected; index += 1) {
    const id = String(index).padStart(2, "0");
    if (!present.has(id)) missing.push(id);
  }
  return missing;
}

function unexpectedIds(present, expected) {
  const allowed = new Set();
  for (let index = 1; index <= expected; index += 1) {
    allowed.add(String(index).padStart(2, "0"));
  }
  return [...present].filter((id) => !allowed.has(id)).sort();
}

/**
 * Every regression/acceptance owner path the canonical registry names. The
 * registry is the source of truth for "which files must exist"; reading it
 * keeps the gate from hard-coding a list that could drift from Appendix A.
 */
function registryOwnerFiles(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, AC_REGISTRY_FILE), "utf8");
  } catch {
    return { regression: [], acceptance: [] };
  }
  const regression = new Set();
  const acceptance = new Set();
  for (const match of text.matchAll(
    /"((?:test\/learning\/regression|test\/learning\/acceptance)\/[^"]+\.test\.ts)"/gu,
  )) {
    const relative = match[1];
    if (relative.startsWith(`${REGRESSION_DIR}/`)) regression.add(relative);
    else acceptance.add(relative);
  }
  return {
    regression: [...regression].sort(),
    acceptance: [...acceptance].sort(),
  };
}

/**
 * Measures the D gate from the filesystem.
 *
 * `regressions` is the number of distinct R01…R17 categories (`rNN-*.test.ts`),
 * not the number of files: a category may have several AC-level files.
 * `matrix` is the number of distinct F01…F10 flows. `missingRegressionFiles`
 * additionally compares the canonical registry's owner set against disk, so
 * deleting one file out of a two-file category is still caught.
 */
export function measureGateCounts(root) {
  const regressionNames = fileNames(path.join(root, REGRESSION_DIR));
  const acceptanceNames = fileNames(path.join(root, ACCEPTANCE_DIR));

  const regressionGroups = new Set();
  let regressionFileCount = 0;
  for (const name of regressionNames) {
    const match = REGRESSION_FILE.exec(name);
    if (match === null) continue;
    regressionGroups.add(match[1]);
    regressionFileCount += 1;
  }

  const acceptanceGroups = new Set();
  let acceptanceFileCount = 0;
  for (const name of acceptanceNames) {
    const match = ACCEPTANCE_FILE.exec(name);
    if (match === null) continue;
    acceptanceGroups.add(match[1]);
    acceptanceFileCount += 1;
  }

  const registry = registryOwnerFiles(root);
  return {
    regressions: regressionGroups.size,
    matrix: acceptanceGroups.size,
    regressionFiles: regressionFileCount,
    acceptanceFiles: acceptanceFileCount,
    missingRegressions: missingIds(
      regressionGroups,
      EXPECTED_REGRESSION_GROUPS,
    ),
    unexpectedRegressions: unexpectedIds(
      regressionGroups,
      EXPECTED_REGRESSION_GROUPS,
    ),
    missingFlows: missingIds(acceptanceGroups, EXPECTED_ACCEPTANCE_FLOWS),
    unexpectedFlows: unexpectedIds(acceptanceGroups, EXPECTED_ACCEPTANCE_FLOWS),
    missingRegressionFiles: registry.regression.filter(
      (relative) => !exists(path.join(root, relative)),
    ),
    missingAcceptanceFiles: registry.acceptance.filter(
      (relative) => !exists(path.join(root, relative)),
    ),
  };
}

/**
 * Finds a committed `.only(`/`.skip(` in any regression or acceptance file.
 * `.skipIf(...)` is allowed because it still executes the suite when its
 * condition holds; the forbidden forms silence a suite unconditionally.
 */
export function findSkippedSuites(root) {
  const offenders = [];
  for (const directory of [REGRESSION_DIR, ACCEPTANCE_DIR]) {
    for (const name of fileNames(path.join(root, directory))) {
      if (!name.endsWith(".test.ts")) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(root, directory, name), "utf8");
      } catch {
        continue;
      }
      if (SKIP_CALL.test(text)) offenders.push(`${directory}/${name}`);
    }
  }
  return offenders.sort();
}

/**
 * Every reason the D gate must be red before a child suite runs. The count is
 * measured, so a deleted or renamed suite names the shortfall instead of
 * certifying a matrix that no longer exists.
 */
function gateProblems(root) {
  const counts = measureGateCounts(root);
  const problems = [];

  const regressionShort =
    counts.regressions !== EXPECTED_REGRESSION_GROUPS ||
    counts.missingRegressions.length > 0 ||
    counts.unexpectedRegressions.length > 0 ||
    counts.missingRegressionFiles.length > 0;
  if (regressionShort) {
    const details = [];
    if (counts.missingRegressions.length > 0) {
      details.push(
        `missing ${counts.missingRegressions.map((id) => `R${id}`).join(",")}`,
      );
    }
    if (counts.unexpectedRegressions.length > 0) {
      details.push(
        `unexpected ${counts.unexpectedRegressions
          .map((id) => `R${id}`)
          .join(",")}`,
      );
    }
    if (counts.missingRegressionFiles.length > 0) {
      details.push(`missing files ${counts.missingRegressionFiles.join(",")}`);
    }
    problems.push(
      `regression_shortfall ${counts.regressions}/${EXPECTED_REGRESSION_GROUPS}` +
        (details.length > 0 ? ` (${details.join("; ")})` : ""),
    );
  }

  const matrixShort =
    counts.matrix !== EXPECTED_ACCEPTANCE_FLOWS ||
    counts.missingFlows.length > 0 ||
    counts.unexpectedFlows.length > 0 ||
    counts.missingAcceptanceFiles.length > 0;
  if (matrixShort) {
    const details = [];
    if (counts.missingFlows.length > 0) {
      details.push(
        `missing ${counts.missingFlows.map((id) => `F${id}`).join(",")}`,
      );
    }
    if (counts.unexpectedFlows.length > 0) {
      details.push(
        `unexpected ${counts.unexpectedFlows.map((id) => `F${id}`).join(",")}`,
      );
    }
    if (counts.missingAcceptanceFiles.length > 0) {
      details.push(`missing files ${counts.missingAcceptanceFiles.join(",")}`);
    }
    problems.push(
      `acceptance_shortfall ${counts.matrix}/${EXPECTED_ACCEPTANCE_FLOWS}` +
        (details.length > 0 ? ` (${details.join("; ")})` : ""),
    );
  }

  const skipped = findSkippedSuites(root);
  if (skipped.length > 0) {
    problems.push(`skipped_suite ${skipped.join(",")}`);
  }

  return problems;
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
    ...(suite.args ?? []),
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

  // The D stage is a count gate as well as a suite gate: a missing or renamed
  // regression/acceptance file, or a silenced suite, must fail before anything
  // is spawned. `counts` names the measured shortfall.
  if (stage.phase === "D") {
    const problems = gateProblems(root);
    if (problems.length > 0) {
      return { name: "counts", error: problems.join("; ") };
    }
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
          ...(suite.args ?? []),
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
 * The counts a D result carries, measured from disk. A/C/B results carry none.
 * `summary` is the literal `regressions:17 matrix:10` line AC-GATE-D names, so
 * a shell assertion can match the documented string without parsing JSON.
 */
function countsOfStage(stage, root) {
  if (stage.phase !== "D") return {};
  const measured = measureGateCounts(root);
  return {
    counts: {
      regressions: measured.regressions,
      matrix: measured.matrix,
    },
    summary: `regressions:${measured.regressions} matrix:${measured.matrix}`,
  };
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
      ...countsOfStage(stage, root),
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
        ...countsOfStage(stage, root),
      };
    }
  }
  return {
    phase: stage.phase,
    passed: true,
    stages,
    ...countsOfStage(stage, root),
  };
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

/** The measured D counts, when the D stage ran; `{}` otherwise. */
function gateCountsOf(results) {
  const stage = results.find(
    (result) => result.phase === "D" && result.counts !== undefined,
  );
  if (stage === undefined) return {};
  return { counts: stage.counts, summary: stage.summary };
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
        ...gateCountsOf(results),
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
        ...gateCountsOf(results),
      };
    }
  }

  return {
    phase: through,
    passed: true,
    stages: flattenStages(results),
    order: checkOrder(results),
    ...gateCountsOf(results),
  };
}

/**
 * Derives every registered phase's pass state by running it — never from a
 * declared list — and then checks the ordering invariant. A red phase blocks
 * nothing from being *observed*: later phases still run, so a gate that is
 * green while A is red is detected rather than hidden.
 *
 * The one exception is a **simulated** red: the phase was never actually run,
 * so continuing would only manufacture a "green while red" artifact and spend
 * minutes running suites whose verdict is already known to be unusable. The
 * simulation still forces the failure and the ordering result.
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
    const result = await runStage(stage, { root, simulated });
    results.push(result);
    if (simulated.has(phase) && result.passed !== true) break;
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
    ...gateCountsOf(results),
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
      // Name the red phase first: the ordering contract is "no later gate is
      // green while an earlier one is red", and an operator needs the culprit.
      return (
        `verify-order failed: phase ${result.order.brokenBy} is red; ` +
        `phase ${result.order.greenWhileRed} is green`
      );
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
