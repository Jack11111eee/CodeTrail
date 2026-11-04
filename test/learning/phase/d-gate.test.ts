/**
 * Phase D gate (AC-GATE-D / AC-GATE-ORDER, PRD §15.4, architecture §18, §19,
 * §21 invariant 4, Appendix A.13/A.14/A.15).
 *
 * Phase D is the release verdict. It must prove three things that a unit test
 * of any one component cannot:
 *
 *   1. The two product flows work end to end against the **built** server
 *      (`dist/learning/api/cli.js`) over HTTP only: research (import → analysis
 *      → published Chinese reader → three-turn Q&A) and follow-up (discovery
 *      tick → change lesson → inbox, with a failure that leaves the published
 *      event untouched).
 *   2. The regression and acceptance suites still exist on disk: the D stage
 *      derives `regressions:17` and `matrix:10` by globbing, and fails naming
 *      the shortfall when a file is deleted or a suite is silenced.
 *   3. `docs/known-issues.md` is non-empty and every entry is reproducible, and
 *      `scripts/accept.mjs` writes `.artifacts/accept/report.json` on both a
 *      green and a red run.
 *
 * The phase-check CLI block is skipped when this file runs *inside*
 * `phase:check` (`CODETRAIL_PHASE_CHECK=1`), otherwise `--through=D` would
 * re-enter itself. The flows and the accept/report checks still run there.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  analyzeToCompletion,
  generationScripts,
  hasChinese,
  importLocal,
  jsonOf,
  makeWritable,
  postJson,
  postMessage,
  qaScripts,
  sourceIdOf,
  startAcceptance,
  type AcceptanceServer,
  type ScriptFile,
} from "../acceptance/support.ts";
import {
  fixturePath,
  fixtureSha,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import { startHarness, type Harness } from "../helpers/http-client.ts";

import { createAppDeps } from "../../../src/learning/api/cli.ts";
import {
  createModelGate,
  executeJob,
} from "../../../src/learning/api/jobs/pipeline.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { changesModule } from "../../../src/learning/api/routes/changes.ts";
import { projectsRoutes } from "../../../src/learning/api/routes/projects.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type {
  AppDeps,
  JobRunnerDeps,
  ModelHandle,
  ProjectId,
  RunningServer,
  WatchTickResult,
} from "../../../src/learning/contracts/index.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { PROMPT_TEMPLATE_VERSION } from "../../../src/learning/config/defaults.ts";
import { createScriptedModel } from "../../../src/learning/testing/scripted-model.ts";
import { createChangeLessonBuilder } from "../../../src/learning/updates/index.ts";
import { createUpstreamGenerationPort } from "../../../src/learning/upstream/generation.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PHASE_CHECK = path.join(REPO_ROOT, "scripts", "phase-check.mjs");
const ACCEPT_SCRIPT = path.join(REPO_ROOT, "scripts", "accept.mjs");
const KNOWN_ISSUES = path.join(REPO_ROOT, "docs", "known-issues.md");
const INSIDE_PHASE_CHECK = process.env.CODETRAIL_PHASE_CHECK === "1";

// ── phase-check D stage: registration, counts, shortfall, ordering ──────────

function runPhaseCheck(
  args: string[],
  options: { timeoutMs?: number } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [PHASE_CHECK, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  });
}

function parsedStdout(
  result: ReturnType<typeof spawnSync>,
): Record<string, unknown> {
  expect(typeof result.stdout).toBe("string");
  return JSON.parse(String(result.stdout).trim()) as Record<string, unknown>;
}

function runScriptModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(PHASE_CHECK).href;
  const source =
    `import * as phaseCheck from ${JSON.stringify(moduleUrl)};\n` +
    `process.stdout.write(JSON.stringify(${expression}));\n`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout)) as unknown;
}

interface StageSeam {
  phase: string;
  testFile: string;
  suites: {
    name: string;
    kind: string;
    paths: string[];
    script: string | null;
  }[];
  counts: { regressions: number; matrix: number } | null;
}

function readStageSeam(): StageSeam[] {
  return runScriptModule(
    "phaseCheck.STAGES.map((stage) => ({ phase: stage.phase, testFile: stage.testFile, suites: stage.suites.map((suite) => ({ name: suite.name, kind: suite.kind, paths: (suite.paths ?? []).map(String), script: typeof suite.script === 'string' ? suite.script : null })), counts: stage.counts ?? null }))",
  ) as StageSeam[];
}

/** The `*.test.ts` files directly inside a real checkout directory, sorted. */
function diskTestFiles(relative: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, relative))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

/**
 * A throwaway tree that satisfies `phase-check`'s preflight without running a
 * real suite: every script is a no-op and every vitest suite is bridged
 * through a stubbed `scripts/with-node.mjs`.
 *
 * The registry and every suite path are read from the checkout rather than
 * hard-coded, so the regression/acceptance counts this root exercises are the
 * same ones measured from disk in production: deleting a real suite shrinks
 * the stub tree and turns the count gate red instead of keeping a stale
 * expectation green.
 */
function createGateRoot(seam: StageSeam[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-d-gate-root-"));
  const write = (relative: string, content = "export {};\n"): void => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  };

  write("scripts/with-node.mjs", "process.exit(0);\n");
  for (const stage of seam) {
    write(stage.testFile);
    for (const suite of stage.suites) {
      if (suite.kind === "script") {
        if (suite.script !== null) write(suite.script, "process.exit(0);\n");
        continue;
      }
      for (const relative of suite.paths) {
        if (relative.endsWith(".test.ts")) {
          write(relative);
        } else {
          for (const name of diskTestFiles(relative)) {
            write(path.join(relative, name));
          }
        }
      }
    }
  }

  // The canonical registry is the gate's per-file expectation; copy the real
  // one so a file deleted out of a multi-file category is still caught.
  const registry = "test/learning/acceptance/ac-registry.ts";
  write(registry, fs.readFileSync(path.join(REPO_ROOT, registry), "utf8"));

  return root;
}

function copyRoot(source: string): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-d-gate-copy-"));
  fs.cpSync(source, copy, { recursive: true });
  return copy;
}

function removeFile(root: string, relative: string): void {
  fs.rmSync(path.join(root, relative), { force: true });
}

function appendToFile(root: string, relative: string, text: string): void {
  fs.appendFileSync(path.join(root, relative), text, "utf8");
}

describe.skipIf(INSIDE_PHASE_CHECK)("phase-check D stage", () => {
  let seam: StageSeam[];
  let base: string;
  const created: string[] = [];

  const freshRoot = (): string => {
    const root = copyRoot(base);
    created.push(root);
    return root;
  };

  beforeAll(() => {
    seam = readStageSeam();
    base = createGateRoot(seam);
    created.push(base);
  }, 60_000);

  afterAll(() => {
    for (const root of created.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("D is registered after C with its own gate test, both suites and the canonical counts", () => {
    expect(seam.map((stage) => stage.phase)).toEqual(["A", "B", "C", "D"]);
    const stage = seam[3];
    expect(stage.testFile).toBe("test/learning/phase/d-gate.test.ts");
    expect(stage.suites.map((suite) => suite.name)).toEqual([
      "regression",
      "acceptance",
      "d-gate",
    ]);
    expect(stage.counts).toEqual({ regressions: 17, matrix: 10 });
    // D never rewrites the earlier registrations.
    expect(seam[0].testFile).toBe("test/learning/phase/a-gate.test.ts");
    expect(seam[1].testFile).toBe("test/learning/phase/b-gate.test.ts");
    expect(seam[2].testFile).toBe("test/learning/phase/c-gate.test.ts");

    const order = runScriptModule(
      "phaseCheck.checkOrder([{phase:'A',passed:true},{phase:'B',passed:true},{phase:'C',passed:true},{phase:'D',passed:false}])",
    ) as Record<string, unknown>;
    expect(order).toMatchObject({ ok: false, brokenBy: "D" });
  }, 60_000);

  test("the counts are globbed from disk, not declared", () => {
    const counts = runScriptModule(
      `phaseCheck.measureGateCounts(${JSON.stringify(base)})`,
    ) as Record<string, unknown>;
    expect(counts).toMatchObject({
      regressions: 17,
      matrix: 10,
      regressionFiles: 27,
      acceptanceFiles: 10,
      missingRegressions: [],
      missingFlows: [],
      missingRegressionFiles: [],
      missingAcceptanceFiles: [],
    });
    expect(
      runScriptModule(`phaseCheck.findSkippedSuites(${JSON.stringify(base)})`),
    ).toEqual([]);
  }, 60_000);

  test("--through=D composes A→D, exits 0 and prints regressions:17 matrix:10", () => {
    const root = freshRoot();
    const result = runPhaseCheck(["--through=D", "--root", root]);
    expect(result.status).toBe(0);
    const json = parsedStdout(result);
    expect(json.phase).toBe("D");
    expect(json.passed).toBe(true);
    expect(json.counts).toEqual({ regressions: 17, matrix: 10 });
    expect(json.order).toMatchObject({ ok: true });
    // The literal documented line, not just the JSON field.
    expect(String(result.stdout)).toContain("regressions:17");
    expect(String(result.stdout)).toContain("matrix:10");

    const names = (json.stages as { name: string }[]).map(
      (stage) => stage.name,
    );
    for (const required of [
      "a-gate",
      "b-gate",
      "updates",
      "c-gate",
      "regression",
      "acceptance",
      "d-gate",
    ]) {
      expect(names).toContain(required);
    }
    expect(names.indexOf("c-gate")).toBeLessThan(names.indexOf("regression"));
    expect(names.indexOf("regression")).toBeLessThan(
      names.indexOf("acceptance"),
    );
    expect(names.indexOf("acceptance")).toBeLessThan(names.indexOf("d-gate"));
  }, 120_000);

  test("deleting a regression category makes the gate red and names the shortfall", () => {
    const root = freshRoot();
    removeFile(root, "test/learning/regression/r05-version-switch.test.ts");
    const result = runPhaseCheck(["--through=D", "--root", root]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.passed).toBe(false);
    expect(json.failed).toMatchObject({ phase: "D", stage: "counts" });
    expect(String(result.stderr)).toContain("regression_shortfall");
    expect(String(result.stderr)).toContain("R05");
  }, 120_000);

  test("deleting one file from a two-file category is still a shortfall", () => {
    const root = freshRoot();
    removeFile(
      root,
      "test/learning/regression/r01-no-invented-decision.test.ts",
    );
    const result = runPhaseCheck(["--through=D", "--root", root]);
    expect(result.status).not.toBe(0);
    // The category count stays 17; the registry comparison catches the file.
    expect(String(result.stderr)).toContain("regression_shortfall");
    expect(String(result.stderr)).toContain("r01-no-invented-decision.test.ts");
  }, 120_000);

  test("deleting an acceptance flow makes the matrix shortfall explicit", () => {
    const root = freshRoot();
    removeFile(
      root,
      "test/learning/acceptance/f05-continuous-qa-refresh.test.ts",
    );
    const result = runPhaseCheck(["--through=D", "--root", root]);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain("acceptance_shortfall");
    expect(String(result.stderr)).toContain("F05");
  }, 120_000);

  test("a silenced suite fails the gate", () => {
    const root = freshRoot();
    appendToFile(
      root,
      "test/learning/regression/r02-numbering-vs-existence.test.ts",
      "describe.skip('silenced', () => {});\n",
    );
    const result = runPhaseCheck(["--through=D", "--root", root]);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain("skipped_suite");
    expect(String(result.stderr)).toContain(
      "r02-numbering-vs-existence.test.ts",
    );
  }, 120_000);

  test("--verify-order exits 0 and --through=D --simulate C=fail exits non-zero", () => {
    const root = freshRoot();
    const verified = runPhaseCheck(["--verify-order", "--root", root]);
    expect(verified.status).toBe(0);
    const verifiedJson = parsedStdout(verified);
    expect(verifiedJson.passed).toBe(true);
    expect(verifiedJson.order).toMatchObject({ ok: true });
    expect(verifiedJson.counts).toEqual({ regressions: 17, matrix: 10 });

    const simulated = runPhaseCheck([
      "--through=D",
      "--simulate",
      "C=fail",
      "--root",
      root,
    ]);
    expect(simulated.status).not.toBe(0);
    const simulatedJson = parsedStdout(simulated);
    expect(simulatedJson.phase).toBe("D");
    expect(simulatedJson.passed).toBe(false);
    expect(simulatedJson.failed).toMatchObject({ phase: "C", simulated: true });
    expect(String(simulated.stderr)).toContain("phase C is red");
  }, 120_000);
});

// ── docs/known-issues.md: non-empty and reproducible ────────────────────────

interface KnownIssue {
  id: string;
  title: string;
  fields: Record<string, string>;
}

interface KnownIssueAudit {
  entries: KnownIssue[];
  problems: string[];
}

const REQUIRED_FIELDS = ["现象", "影响", "复现", "状态"] as const;

/** Splits `### KI-nn title` blocks and their `label: value` lines. */
function parseKnownIssues(text: string): KnownIssue[] {
  const entries: KnownIssue[] = [];
  const blocks = text.split(/^###\s+/mu).slice(1);
  for (const block of blocks) {
    const header = /^KI-(\d+)\s+(.+)$/mu.exec(block.trimStart());
    if (header === null) continue;
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const match = /^\s*[-*]?\s*(现象|影响|复现|状态)\s*[:：]\s*(.+)$/u.exec(
        line,
      );
      if (match !== null) fields[match[1]] = match[2].trim();
    }
    entries.push({
      id: `KI-${header[1]}`,
      title: header[2].trim(),
      fields,
    });
  }
  return entries;
}

function packageScripts(): Record<string, string> {
  return (
    JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    }
  ).scripts;
}

function fileExists(relative: string): boolean {
  try {
    return fs.statSync(path.join(REPO_ROOT, relative)).isFile();
  } catch {
    return false;
  }
}

/** Every path/command a `复现` line names must exist in this checkout. */
function reproProblems(command: string): string[] {
  const problems: string[] = [];
  const scripts = packageScripts();
  for (const match of command.matchAll(/`([^`]+)`/gu)) {
    const literal = match[1].trim();
    if (literal === "") continue;
    const pnpm = /^pnpm\s+run\s+([^\s]+)/u.exec(literal);
    if (pnpm !== null && !(pnpm[1] in scripts)) {
      problems.push(`unknown_script:${pnpm[1]}`);
    }
    const node = /^node\s+([^\s]+)/u.exec(literal);
    if (node !== null && !fileExists(node[1])) {
      problems.push(`missing_script:${node[1]}`);
    }
    // Repository paths named anywhere in the command (including after `--`).
    for (const token of literal.split(/\s+/u)) {
      if (!token.startsWith("test/") && !token.startsWith("scripts/")) continue;
      if (!fileExists(token)) problems.push(`missing_path:${token}`);
    }
  }
  return problems;
}

function auditKnownIssues(text: string): KnownIssueAudit {
  const entries = parseKnownIssues(text);
  const problems: string[] = [];
  if (text.trim() === "") problems.push("empty_file");
  if (entries.length === 0) problems.push("no_entries");
  for (const entry of entries) {
    for (const field of REQUIRED_FIELDS) {
      const value = entry.fields[field];
      if (value === undefined || value.trim() === "") {
        problems.push(`${entry.id}:missing_${field}`);
      }
    }
    const repro = entry.fields["复现"];
    if (repro !== undefined) {
      for (const problem of reproProblems(repro)) {
        problems.push(`${entry.id}:${problem}`);
      }
    }
  }
  return { entries, problems };
}

describe("docs/known-issues.md", () => {
  test("is non-empty and every entry is reproducible", () => {
    expect(fs.existsSync(KNOWN_ISSUES)).toBe(true);
    const audit = auditKnownIssues(fs.readFileSync(KNOWN_ISSUES, "utf8"));
    expect(audit.entries.length).toBeGreaterThan(0);
    expect(audit.problems).toEqual([]);
    for (const entry of audit.entries) {
      expect(entry.id).toMatch(/^KI-\d+$/u);
      expect(entry.title).not.toBe("");
      expect(entry.fields["复现"]).toMatch(/pnpm run |node scripts\//u);
    }
  });

  test("rejects an empty file, a missing field and a dangling repro command", () => {
    expect(auditKnownIssues("").problems).toContain("empty_file");

    const missingField = [
      "### KI-01 no status",
      "- 现象: something",
      "- 影响: somewhere",
      "- 复现: `pnpm run test:learning`",
    ].join("\n");
    expect(auditKnownIssues(missingField).problems).toContain(
      "KI-01:missing_状态",
    );

    const dangling = [
      "### KI-02 dangling",
      "- 现象: something",
      "- 影响: somewhere",
      "- 复现: `node scripts/does-not-exist.mjs`",
      "- 状态: known",
    ].join("\n");
    expect(auditKnownIssues(dangling).problems).toContain(
      "KI-02:missing_script:scripts/does-not-exist.mjs",
    );
  });
});

// ── accept: the report is written on success and on partial failure ─────────

interface AcceptStep {
  name: string;
  script: string;
  ok: boolean;
  skipped?: boolean;
  exitCode?: number;
}

interface AcceptReport {
  ok: boolean;
  steps: AcceptStep[];
  reportFile: string;
}

function runAcceptInChild(root: string, failStep: string | null): AcceptReport {
  const moduleUrl = pathToFileURL(ACCEPT_SCRIPT).href;
  const predicate =
    failStep === null ? "true" : `step.name !== ${JSON.stringify(failStep)}`;
  const source =
    `import { runAccept } from ${JSON.stringify(moduleUrl)};\n` +
    `const report = await runAccept({\n` +
    `  repoRoot: ${JSON.stringify(root)},\n` +
    `  runStep: (step) => ({ ok: ${predicate} }),\n` +
    `});\n` +
    `process.stdout.write(JSON.stringify(report));\n`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout)) as AcceptReport;
}

describe("accept report", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-accept-"));
    roots.push(root);
    return root;
  }

  test("a green run writes the report with every stage passed", () => {
    const root = tempRoot();
    const report = runAcceptInChild(root, null);
    expect(report.ok).toBe(true);
    expect(report.steps).toHaveLength(7);
    for (const step of report.steps) {
      expect(step.ok).toBe(true);
      expect(step.skipped).toBeUndefined();
    }
    const file = path.join(root, ".artifacts", "accept", "report.json");
    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as AcceptReport;
    expect(written.ok).toBe(true);
    expect(written.steps.map((step) => step.name)).toEqual(
      report.steps.map((step) => step.name),
    );
  });

  test("a red step is reported, later steps are skipped, and the report is still written", () => {
    const root = tempRoot();
    const report = runAcceptInChild(root, "build");
    expect(report.ok).toBe(false);
    const build = report.steps.find((step) => step.name === "build")!;
    expect(build.ok).toBe(false);
    expect(build.skipped).toBeUndefined();
    const later = report.steps.filter((step) => step.name !== "build");
    expect(later.some((step) => step.skipped === true)).toBe(true);
    for (const step of report.steps) {
      if (step.name === "build") continue;
      if (step.skipped === true) expect(step.ok).toBe(false);
    }
    const file = path.join(root, ".artifacts", "accept", "report.json");
    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as AcceptReport;
    expect(written.ok).toBe(false);
    expect(written.steps.find((step) => step.name === "build")?.ok).toBe(false);
  });
});

// ── end-to-end flow 1: research ─────────────────────────────────────────────

interface LessonDetailView {
  lesson: {
    context: { commitSha: string };
    plainExplanation: { text: string }[];
    technicalExplanation: {
      text: string;
      terms: { zh: string; en: string }[];
    }[];
    statements: { text: string }[];
  };
  diagram: { commitSha: string };
  html: string;
}

interface ConversationView {
  conversationId: string;
  generationIds: string[];
  messages: {
    messageId: string;
    role: string;
    content: string;
    status: string;
    citations: { generationId: string; commitSha: string }[];
  }[];
}

const RESEARCH_SOURCE = "src/stock.ts";
const RESEARCH_LINES = { start: 1, end: 6 };

let server: AcceptanceServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
}, 240_000);

describe("phase D — research flow", () => {
  test("import → analysis → published Chinese reader → three-turn Q&A on one commit", async () => {
    server = await startAcceptance({ fixture: "evolution" });
    server.writeScripts(
      generationScripts({
        sourcePath: RESEARCH_SOURCE,
        lines: RESEARCH_LINES,
        commitSha: server.commitSha,
      }),
    );

    const project = await importLocal(server);
    const { analysis, job } = await analyzeToCompletion(
      server,
      project.projectId,
    );
    expect(job.state).toBe("completed");
    expect(job.outputGenerationId).toBe(analysis.generationId);

    // The published reader: Chinese prose, bilingual terms, commit-bound
    // diagram sources and a rendered HTML body.
    const list = jsonOf<{ lessons: { lessonId: string }[] }>(
      await server.request(`/api/generations/${analysis.generationId}/lessons`),
      200,
    );
    expect(list.lessons.length).toBeGreaterThan(0);
    const detail = jsonOf<LessonDetailView>(
      await server.request(
        `/api/generations/${analysis.generationId}/lessons/${list.lessons[0].lessonId}`,
      ),
      200,
    );
    expect(detail.lesson.context.commitSha).toBe(server.commitSha);
    expect(detail.diagram.commitSha).toBe(server.commitSha);
    expect(detail.lesson.plainExplanation.length).toBeGreaterThan(0);
    expect(hasChinese(detail.lesson.plainExplanation[0].text)).toBe(true);
    expect(detail.lesson.technicalExplanation[0].terms[0].zh).not.toBe("");
    expect(detail.lesson.technicalExplanation[0].terms[0].en).not.toBe("");
    expect(detail.html).not.toBe("");
    expect(hasChinese(detail.html)).toBe(true);

    // Three turns stay on the published generation and every citation is
    // bound to the same commit.
    const codeId = sourceIdOf(
      RESEARCH_SOURCE,
      server.commitSha,
      RESEARCH_LINES,
    );
    server.writeScripts(qaScripts({ citations: [{ sourceId: codeId }] }));
    const conversation = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [analysis.generationId],
      }),
      201,
    );
    for (const question of [
      "为什么把 copies 改成 quantity",
      "重命名后调用方怎么处理",
      "这个变更还有哪些边界",
    ]) {
      const events = await postMessage(server, conversation.conversationId, {
        text: question,
      });
      expect(
        events.find((event) => event.type === "done" && event.status),
      ).toMatchObject({ type: "done", status: "complete" });
    }

    const view = jsonOf<ConversationView>(
      await server.request(`/api/conversations/${conversation.conversationId}`),
      200,
    );
    expect(view.generationIds).toEqual([analysis.generationId]);
    const answers = view.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(answers).toHaveLength(3);
    for (const answer of answers) {
      expect(answer.status).toBe("complete");
      expect(answer.citations[0].generationId).toBe(analysis.generationId);
      expect(answer.citations[0].commitSha).toBe(server.commitSha);
    }
  }, 240_000);
});

// ── end-to-end flow 2: follow-up ────────────────────────────────────────────

const WATCH_README = "README.md";
const WATCH_LINES = { start: 1, end: 1 };

interface ChangeSummary {
  changeId: string;
  kind: string;
  state: string;
  headSha: string | null;
  publishedAt: string | null;
}

interface ChangeList {
  items: ChangeSummary[];
}

interface ChangeDetail {
  change: ChangeSummary;
  lesson: Record<string, unknown> | null;
}

/** Clones the mirror and pushes one new default-branch commit into it. */
function commitOnTopOfMirror(mirrorPath: string): string {
  const working = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-d-watch-"));
  try {
    execFileSync("git", ["clone", "--quiet", mirrorPath, working], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["-C", working, "config", "user.email", "d-gate@x"]);
    execFileSync("git", ["-C", working, "config", "user.name", "D Gate"]);
    fs.appendFileSync(
      path.join(working, WATCH_README),
      `\n- follow-up ${String(Date.now())}\n`,
      "utf8",
    );
    execFileSync("git", ["-C", working, "add", WATCH_README]);
    execFileSync("git", [
      "-C",
      working,
      "commit",
      "--quiet",
      "-m",
      "change the approval path",
    ]);
    const sha = execFileSync("git", ["-C", working, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync(
      "git",
      ["-C", working, "push", mirrorPath, "HEAD:refs/heads/main"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return sha;
  } finally {
    fs.rmSync(working, { recursive: true, force: true });
  }
}

function writeScripts(scriptDir: string, scripts: ScriptFile): void {
  fs.writeFileSync(
    path.join(scriptDir, "scripts.json"),
    JSON.stringify(scripts, null, 2),
    "utf8",
  );
}

/**
 * A model handle that reads the scripted fixture directly from TypeScript.
 *
 * The production fixture provider loads `../testing/scripted-model.js` through
 * `createRequire`, which only resolves from the compiled `dist` tree; the
 * in-process gate therefore builds the same scripted model from source. Its
 * role is `lesson`, which is what `createFixtureModel` hard-codes — so a change
 * script is keyed as `lesson` (see {@link changeScripts}).
 */
function fixtureModelHandle(scriptDir: string): ModelHandle {
  return {
    modelId: "fixture",
    settings: {
      provider: "fixture",
      model: "fixture",
      maxOutputTokens: 4096,
      temperature: 0,
      pricing: null,
      quota: {
        maxCalls: 1000,
        maxInputTokens: 10_000_000,
        maxOutputTokens: 10_000_000,
      },
    },
    chat: () =>
      createScriptedModel({
        dir: scriptDir,
        role: "lesson",
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      }),
    estimate: () => ({ calls: 1, tokens: 0 }),
  };
}

/**
 * Re-keys a `generationScripts` change entry to the `lesson` worker kind the
 * fixture provider actually uses, and drops the research entries: the change
 * job must not consume the research lesson body.
 */
function changeScripts(scripts: ScriptFile): ScriptFile {
  const change = scripts.scripts.find((entry) => entry.workerKind === "change");
  if (change === undefined) {
    throw new Error("generationScripts did not include a change lesson");
  }
  return { scripts: [{ ...change, workerKind: "lesson" }] };
}

/**
 * The follow-up harness: the real composition root (`createAppDeps`), the real
 * discovery service and the real change pipeline, with the built-in job runner
 * replaced by a deterministic drain.
 *
 * Discovery writes its jobs straight into the transaction (`commitDiscovery`)
 * and does not call `JobRunner.enqueue`, so the built server's runner never
 * sees them. This gate therefore drives `runWatchTick` (as the issue's testing
 * strategy names) and executes the queued rows through the production
 * `executeJob`, which is the same pipeline the built server runs. The inbox and
 * the change lesson are then read through the real HTTP routes.
 */
interface FollowUpGate {
  deps: AppDeps;
  projectId: ProjectId;
  dataDir: string;
  scriptDir: string;
  mirror: string;
  fake: FakeGithub;
  harness: Harness;
  server: RunningServer;
  tick(): Promise<WatchTickResult>;
  runPending(): Promise<void>;
  changes(): Promise<ChangeList>;
  detail(changeId: string): Promise<ChangeDetail>;
  close(): Promise<void>;
}

async function createFollowUpGate(): Promise<FollowUpGate> {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codetrail-d-follow-data-"),
  );
  const scriptDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codetrail-d-follow-scripts-"),
  );
  const fake = await startFakeGithub({
    ownerRepo: "acme/watch",
    pages: 1,
    perPage: 1,
    gitRepoPath: fixturePath("watch-remote.git"),
  });
  // The projects route reads this from `process.env` when it rewrites the
  // clone origin to the fake's Git smart-HTTP endpoint; restore it on close.
  const previousBaseUrl = process.env.CODETRAIL_GITHUB_API_BASE_URL;
  process.env.CODETRAIL_GITHUB_API_BASE_URL = fake.baseUrl;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODETRAIL_DATA_DIR: dataDir,
    CODETRAIL_PORT: "0",
    CODETRAIL_NOW: "2024-06-01T00:05:00.000Z",
    CODETRAIL_WATCH_INTERVAL_MS: "3600000",
    CODETRAIL_MODEL_PROVIDER: "fixture",
    CODETRAIL_FIXTURE_DIR: scriptDir,
    CODETRAIL_GITHUB_API_BASE_URL: fake.baseUrl,
  };
  delete env.CODETRAIL_GITHUB_TOKEN;

  // Persist the model settings before the composition root constructs its
  // handle — the same configure-then-boot path the acceptance harness uses.
  const paths = resolveDataPaths(env);
  await ensureDataDir(paths);
  const seed = openDatabase({ file: paths.db });
  migrate(seed);
  createRepositories(seed).settings.putModel({
    provider: "fixture",
    model: "fixture",
    maxOutputTokens: 4096,
    temperature: 0,
    quota: {
      maxCalls: 1000,
      maxInputTokens: 10_000_000,
      maxOutputTokens: 10_000_000,
    },
  });
  seed.close();

  const deps = await createAppDeps(env);
  if (deps.model === null) {
    throw new Error("the fixture model was not configured");
  }

  registerRouteModule(projectsRoutes);
  registerRouteModule(changesModule);
  const server = await createLearningServer({
    paths: deps.paths,
    port: 0,
    clock: deps.clock,
    deps,
  });
  const harness = await startHarness({ baseUrl: server.url });
  await harness.bootstrap();

  const jobDeps: JobRunnerDeps = {
    db: deps.db,
    repos: deps.repos,
    paths: deps.paths,
    clock: deps.clock,
    snapshotService: deps.snapshotService,
    publisher: deps.publisher,
    upstream: createUpstreamGenerationPort(),
    lessons: createChangeLessonBuilder(),
    model: fixtureModelHandle(scriptDir),
    usage: deps.usage,
    registry: deps.registry,
    external: deps.external,
  };
  const modelGate = createModelGate();

  const gate: FollowUpGate = {
    deps,
    projectId: "" as ProjectId,
    dataDir,
    scriptDir,
    mirror: "",
    fake,
    harness,
    server,
    async tick() {
      const [result] = await deps.watch.runTick(gate.projectId);
      return result;
    },
    async runPending() {
      for (;;) {
        const queued = deps.repos.jobs.listByProject(gate.projectId, [
          "queued",
        ]);
        if (queued.length === 0) return;
        const job = queued[0];
        const at = deps.clock.now().toISOString();
        const started = deps.repos.jobs.transition(
          job.jobId,
          ["queued"],
          "running",
          {
            startedAt: at,
            attempt: 1,
            errorCode: null,
            errorDetail: null,
            finishedAt: null,
          },
        );
        if (!started) continue;
        deps.repos.attempts.open(job.jobId, 1, at);
        const current = deps.repos.jobs.byId(job.jobId);
        if (current === null) continue;
        try {
          const result = await executeJob({
            deps: jobDeps,
            job: current,
            signal: new AbortController().signal,
            gate: modelGate,
          });
          const latest = deps.repos.jobs.byId(job.jobId);
          if (latest !== null && latest.state === "running") {
            deps.repos.jobs.transition(job.jobId, ["running"], "completed", {
              outputGenerationId: result.generationId,
              finishedAt: deps.clock.now().toISOString(),
              errorCode: null,
              errorDetail: null,
            });
          }
        } catch (error) {
          const latest = deps.repos.jobs.byId(job.jobId);
          if (latest !== null && latest.state === "running") {
            deps.repos.jobs.transition(job.jobId, ["running"], "failed", {
              finishedAt: deps.clock.now().toISOString(),
              errorCode: "internal_error",
              errorDetail:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    },
    async changes() {
      return jsonOf<ChangeList>(
        await harness.request(
          `/api/projects/${gate.projectId}/changes?limit=50`,
        ),
        200,
      );
    },
    async detail(changeId) {
      return jsonOf<ChangeDetail>(
        await harness.request(
          `/api/projects/${gate.projectId}/changes/${changeId}`,
        ),
        200,
      );
    },
    async close() {
      await harness.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await fake.close().catch(() => undefined);
      if (previousBaseUrl === undefined) {
        delete process.env.CODETRAIL_GITHUB_API_BASE_URL;
      } else {
        process.env.CODETRAIL_GITHUB_API_BASE_URL = previousBaseUrl;
      }
      try {
        deps.db.close();
      } catch {
        // already closed
      }
      // Published knowledge trees are sealed read-only; unlock before removing.
      makeWritable(dataDir);
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
      fs.rmSync(scriptDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return gate;
}

describe("phase D — follow-up flow", () => {
  test("discovery tick → change lesson → inbox; a failure leaves the published event untouched", async () => {
    const mainHead = fixtureSha("watch-remote.git", "main");
    const gate = await createFollowUpGate();
    try {
      gate.fake.pushCommit(mainHead);
      // No change script yet: any PR job from the first tick fails loudly.
      writeScripts(gate.scriptDir, { scripts: [] });

      const imported = jsonOf<{ projectId: string; repoId: string }>(
        await gate.harness.request("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ githubUrl: "https://github.com/acme/watch" }),
        }),
        201,
      );
      gate.projectId = imported.projectId as ProjectId;
      gate.mirror = path.join(
        gate.dataDir,
        "mirrors",
        `${imported.repoId}.git`,
      );
      // Enable follow-up through the real route; the ticks themselves are
      // driven directly so the gate never sleeps on the scheduler.
      const watched = await gate.harness.request(
        `/api/projects/${gate.projectId}/watch`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(watched.status).toBe(200);

      // First tick: the default-branch baseline (the fixture also exposes a
      // PR, so discovery is at least one; the baseline is what this pins).
      const first = await gate.tick();
      expect(first.discovered).toBeGreaterThanOrEqual(1);
      const baseline = (await gate.changes()).items.find(
        (item) => item.kind === "baseline",
      );
      expect(baseline?.headSha).toBe(mainHead);

      // One new default-branch commit becomes one event and one change job.
      const newHead = commitOnTopOfMirror(gate.mirror);
      gate.fake.pushCommit(newHead);
      writeScripts(
        gate.scriptDir,
        changeScripts(
          generationScripts({
            sourcePath: WATCH_README,
            lines: WATCH_LINES,
            commitSha: mainHead,
            includeChange: true,
            changeCommitSha: newHead,
          }),
        ),
      );
      const second = await gate.tick();
      expect(second.discovered).toBe(1);
      expect(second.enqueued).toBe(1);
      await gate.runPending();

      const published = (await gate.changes()).items.find(
        (item) => item.headSha === newHead,
      );
      expect(published).toMatchObject({ kind: "commit", state: "published" });
      expect(published?.publishedAt).not.toBeNull();
      const publishedDetail = await gate.detail(published!.changeId);
      expect(publishedDetail.lesson).not.toBeNull();
      expect(hasChinese(JSON.stringify(publishedDetail.lesson))).toBe(true);

      // A second change whose analysis has no script fails; its event survives
      // unpublished and the earlier published event is untouched.
      const failedHead = commitOnTopOfMirror(gate.mirror);
      gate.fake.pushCommit(failedHead);
      // No script for this analysis: the job fails, the event is retained.
      writeScripts(gate.scriptDir, { scripts: [] });
      const third = await gate.tick();
      expect(third.discovered).toBe(1);
      expect(third.enqueued).toBe(1);
      await gate.runPending();
      // A quiet tick reconciles the failed job onto its event.
      await gate.tick();

      const inbox = await gate.changes();
      const failed = inbox.items.find((item) => item.headSha === failedHead);
      expect(failed).toMatchObject({
        kind: "commit",
        state: "failed",
        publishedAt: null,
      });
      const failedDetail = await gate.detail(failed!.changeId);
      expect(failedDetail.lesson).toBeNull();

      const stillPublished = inbox.items.find(
        (item) => item.changeId === published!.changeId,
      );
      expect(stillPublished).toMatchObject({
        state: "published",
        publishedAt: published!.publishedAt,
      });
      // The failed event is still reachable in the inbox, never dropped.
      expect(
        inbox.items.some((item) => item.changeId === failed!.changeId),
      ).toBe(true);
    } finally {
      await gate.close();
    }
  }, 300_000);
});

// ── fixtures / build prerequisites ──────────────────────────────────────────

beforeAll(() => {
  if (!fs.existsSync(path.join(fixturesDir(), "manifest.json"))) {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  }
  requireFixtures();
}, 180_000);
