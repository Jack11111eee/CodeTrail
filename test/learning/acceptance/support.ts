/**
 * Shared harness for the ten acceptance flows (Appendix A.14).
 *
 * Every flow boots the **built** composition root (`dist/learning/api/cli.js`)
 * on port 0 with a temporary data directory, the scripted model and (when the
 * flow needs it) the fake GitHub server. Assertions then go through HTTP only;
 * the helpers here only *operate* the process and stage deterministic model
 * scripts, never inspect service internals.
 *
 * The first boot exists only to persist `PUT /api/settings/model`: the
 * composition root constructs its model handle once at boot, so the model must
 * be configured before the boot the flow itself uses. That is the same operator
 * path a user follows (configure, restart) and keeps production code untouched.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  startFakeGithub,
  type FakeGithub,
  type FakeGithubOptions,
} from "../helpers/fake-github.ts";
import {
  fixturePath,
  fixtureSha,
  requireFixtures,
} from "../helpers/git-fixture.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "learning", "api", "cli.js");
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)$/mu;
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export interface ScriptStep {
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  content?: string;
}

export interface ScriptEntry {
  workerKind: "planner" | "page" | "lesson" | "qa" | "change";
  pagePath?: string;
  promptTemplateVersion?: string;
  occurrence?: number;
  steps: ScriptStep[];
}

export interface ScriptFile {
  scripts: ScriptEntry[];
}

export interface AcceptanceOptions {
  /** Fixture used for the local import; defaults to `last-mile-mini`. */
  fixture?: string;
  /** Persist a model settings row before the flow boot; default true. */
  configureModel?: boolean;
  /** Model settings persisted in the first boot. */
  settings?: {
    provider?: string;
    model?: string;
    maxOutputTokens?: number;
    temperature?: number;
    quota?: {
      maxCalls?: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
    };
  };
  /** Fake GitHub server to start before the first boot. */
  github?: FakeGithubOptions;
  /** Extra server environment for every boot. */
  env?: Record<string, string>;
}

interface RunningProcess {
  child: ReturnType<typeof spawn>;
  url: string;
  baseUrl: string;
  stdout: string;
  stderr: string;
  exit: Promise<number | null>;
}

export interface AcceptanceServer {
  readonly dataDir: string;
  readonly scriptDir: string;
  readonly fixturePath: string;
  readonly commitSha: string;
  readonly fakeGithub: FakeGithub | null;
  request(pathname: string, init?: RequestInit): Promise<HarnessResponse>;
  writeScripts(scripts: ScriptFile): void;
  /** Starts a second fake server (e.g. the token-gated private one). */
  startFake(options: FakeGithubOptions): Promise<FakeGithub>;
  /** Rebooting with extra environment, on the same data directory. */
  restart(envPatch?: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

/** Deterministic source id (architecture §8.1): `s_` + first 16 hex. */
export function sourceIdOf(
  relPath: string,
  commitSha: string,
  lines: { start: number; end: number } | null,
): string {
  const segment = lines === null ? "null" : `${lines.start}-${lines.end}`;
  const identity = `repo:${relPath}\u0000${commitSha}\u0000${segment}`;
  return `s_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

/** Builds a bare clone of a fixture so the fake server can serve it over git. */
export function makeBareCopy(sourceFixture: string, targetDir: string): string {
  const destination = path.join(targetDir, `${sourceFixture}.git`);
  fs.mkdirSync(targetDir, { recursive: true });
  execFileSync(
    "git",
    ["clone", "--bare", fixturePath(sourceFixture), destination],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return destination;
}

function requireBuiltCli(): void {
  if (!fs.existsSync(CLI)) {
    throw new Error(
      `missing ${CLI}; run \`pnpm run build\` before the acceptance suite`,
    );
  }
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // A token inherited from the shell would silently authorise the "no token"
  // half of F01/F10; only an explicit per-test value may reach the server.
  delete environment.CODETRAIL_GITHUB_TOKEN;
  return {
    ...environment,
    CODETRAIL_PORT: "0",
    CODETRAIL_NOW: FIXED_NOW,
    // Manual refresh drives every tick; the timer must not fire mid-assertion.
    CODETRAIL_WATCH_INTERVAL_MS: "3600000",
    CODETRAIL_MODEL_PROVIDER: "fixture",
    ...extra,
  };
}

function spawnServer(
  dataDir: string,
  env: Record<string, string>,
): Promise<RunningProcess> {
  const child = spawn(process.execPath, [CLI], {
    cwd: REPO_ROOT,
    env: baseEnv({ CODETRAIL_DATA_DIR: dataDir, ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return new Promise<RunningProcess>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `built entry did not print a URL within 30 s\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    }, 30_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (process.env.CODETRAIL_ACCEPT_DEBUG === "1")
        process.stderr.write(text);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = URL_PATTERN.exec(stdout);
      if (match === null) return;
      clearTimeout(timer);
      const url = match[0];
      resolve({
        child,
        url,
        baseUrl: url.replace(/\/$/u, ""),
        stdout,
        stderr,
        exit,
      });
    });
    void exit.then((code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `built entry exited before printing a URL (code ${String(code)})\n` +
            `stderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    });
  });
}

async function stopProcess(running: RunningProcess): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return;
  }
  running.child.kill("SIGTERM");
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  await Promise.race([running.exit.then(() => undefined), timeout]);
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill("SIGKILL");
    await running.exit;
  }
}

/** Sealed generation directories are read-only; cleanup must unlock them. */
export function makeWritable(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeWritable(child);
      try {
        fs.chmodSync(child, 0o755);
      } catch {
        // A path may have vanished between readdir and chmod.
      }
    } else if (entry.isFile()) {
      try {
        fs.chmodSync(child, 0o644);
      } catch {
        // Same as above.
      }
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // The root may already be gone.
  }
}

function removeTree(root: string): void {
  makeWritable(root);
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

export async function startAcceptance(
  options: AcceptanceOptions = {},
): Promise<AcceptanceServer> {
  requireFixtures();
  requireBuiltCli();

  const fixture = options.fixture ?? "last-mile-mini";
  const fixtureDir = fixturePath(fixture);
  const commitSha = fixtureSha(fixture);
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codetrail-accept-data-"),
  );
  const scriptDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codetrail-accept-scripts-"),
  );
  const fakes: FakeGithub[] = [];
  let fakeGithub: FakeGithub | null = null;

  if (options.github !== undefined) {
    fakeGithub = await startFakeGithub(options.github);
    fakes.push(fakeGithub);
  }

  const env: Record<string, string> = {
    CODETRAIL_FIXTURE_DIR: scriptDir,
    ...(options.env ?? {}),
  };
  if (fakeGithub !== null) {
    env.CODETRAIL_GITHUB_API_BASE_URL = fakeGithub.baseUrl;
  }

  let running: RunningProcess | null = null;
  let harness: Harness | null = null;

  const boot = async (): Promise<void> => {
    running = await spawnServer(dataDir, env);
    harness = await startHarness({ baseUrl: running.baseUrl });
    await harness.bootstrap();
  };

  const stop = async (): Promise<void> => {
    if (harness !== null) await harness.close();
    harness = null;
    if (running !== null) {
      await stopProcess(running);
      running = null;
    }
  };

  const request = async (
    pathname: string,
    init: RequestInit = {},
  ): Promise<HarnessResponse> => {
    if (harness === null) throw new Error("acceptance server is not running");
    return harness.request(pathname, init);
  };

  await boot();

  if (options.configureModel !== false) {
    const settings = options.settings ?? {};
    const response = await request("/api/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: settings.provider ?? "fixture",
        model: settings.model ?? "fixture",
        maxOutputTokens: settings.maxOutputTokens ?? 4096,
        temperature: settings.temperature ?? 0,
        quota: {
          maxCalls: settings.quota?.maxCalls ?? 1000,
          maxInputTokens: settings.quota?.maxInputTokens ?? 10_000_000,
          maxOutputTokens: settings.quota?.maxOutputTokens ?? 10_000_000,
        },
      }),
    });
    if (response.status !== 200) {
      throw new Error(
        `model configuration failed: ${response.status} ${response.text}`,
      );
    }
    await stop();
    await boot();
  }

  const server: AcceptanceServer = {
    dataDir,
    scriptDir,
    fixturePath: fixtureDir,
    commitSha,
    get fakeGithub() {
      return fakeGithub;
    },
    request,
    writeScripts(scripts: ScriptFile): void {
      fs.writeFileSync(
        path.join(scriptDir, "scripts.json"),
        JSON.stringify(scripts, null, 2),
        "utf8",
      );
    },
    async startFake(next: FakeGithubOptions): Promise<FakeGithub> {
      const created = await startFakeGithub(next);
      fakes.push(created);
      return created;
    },
    async restart(envPatch: Record<string, string> = {}): Promise<void> {
      await stop();
      Object.assign(env, envPatch);
      await boot();
    },
    stop,
    async close(): Promise<void> {
      await stop();
      for (const fake of fakes) await fake.close();
      removeTree(dataDir);
      removeTree(scriptDir);
    },
  };

  return server;
}

// ── HTTP convenience ────────────────────────────────────────────────────────

export function jsonOf<T>(response: HarnessResponse, status?: number): T {
  if (status !== undefined && response.status !== status) {
    throw new Error(
      `expected ${status}, got ${response.status}: ${response.text.slice(0, 500)}`,
    );
  }
  return response.json as T;
}

export function postJson(
  server: AcceptanceServer,
  pathname: string,
  body: unknown,
): Promise<HarnessResponse> {
  return server.request(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function putJson(
  server: AcceptanceServer,
  pathname: string,
  body: unknown,
): Promise<HarnessResponse> {
  return server.request(pathname, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_JOB_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface JobViewLike {
  jobId: string;
  state: string;
  errorCode: string | null;
  outputGenerationId: string | null;
  retryable: boolean;
  attempt: number;
  streamId: string | null;
}

export async function waitForJob(
  server: AcceptanceServer,
  jobId: string,
  timeoutMs = 60_000,
): Promise<JobViewLike> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await server.request(`/api/jobs/${jobId}`);
    const job = jsonOf<JobViewLike>(response);
    if (TERMINAL_JOB_STATES.has(job.state)) return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} stayed ${job.state} for ${timeoutMs} ms`);
    }
    await sleep(20);
  }
}

export interface AnalysisView {
  jobId: string;
  generationId: string;
  cacheHit: boolean;
}

export async function importLocal(
  server: AcceptanceServer,
  localPath = server.fixturePath,
): Promise<{ projectId: string; repoId: string }> {
  return jsonOf<{ projectId: string; repoId: string }>(
    await postJson(server, "/api/projects", { localPath }),
    201,
  );
}

export async function importGithub(
  server: AcceptanceServer,
  githubUrl: string,
  expectedStatus = 201,
): Promise<{ projectId: string; repoId: string }> {
  return jsonOf<{ projectId: string; repoId: string }>(
    await postJson(server, "/api/projects", { githubUrl }),
    expectedStatus,
  );
}

export async function submitAnalysis(
  server: AcceptanceServer,
  projectId: string,
  body: Record<string, unknown> = { ref: "main" },
): Promise<AnalysisView> {
  return jsonOf<AnalysisView>(
    await postJson(server, `/api/projects/${projectId}/analyses`, body),
    202,
  );
}

export async function analyzeToCompletion(
  server: AcceptanceServer,
  projectId: string,
  body: Record<string, unknown> = { ref: "main" },
): Promise<{ analysis: AnalysisView; job: JobViewLike }> {
  const analysis = await submitAnalysis(server, projectId, body);
  const job = await waitForJob(server, analysis.jobId);
  return { analysis, job };
}

/** Parses `data:` frames from an SSE response body. */
export function sseEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed === "object" && parsed !== null) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A non-JSON data frame is not part of this API.
    }
  }
  return events;
}

export async function postMessage(
  server: AcceptanceServer,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const response = await server.request(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `message failed: ${response.status} ${response.text.slice(0, 500)}`,
    );
  }
  return sseEvents(response.text);
}

// ── deterministic model scripts ─────────────────────────────────────────────

const CJK = /[\u3400-\u9fff]/u;

export function hasChinese(text: string): boolean {
  return CJK.test(text);
}

export interface GenerationScriptOptions {
  /** Repository path cited by the page claim and lesson evidence. */
  sourcePath: string;
  /** Line range for the code source; `null` cites the whole file. */
  lines: { start: number; end: number } | null;
  /**
   * Repository path cited as a design/decision document. Omit it when the
   * fixture has no design doc: the lesson then teaches code facts only.
   */
  designPath?: string;
  commitSha: string;
  /** Additional wiki pages; each becomes one page-worker job. */
  extraPages?: string[];
  /** Replace the whole lesson body with raw JSON text. */
  lessonOverride?: string;
  /** Patch the standard lesson body before it is serialised. */
  lessonPatch?: Record<string, unknown>;
  /** Include a change-lesson entry for `watch` flows. */
  includeChange?: boolean;
  /** Head commit used by the change lesson's evidence. */
  changeCommitSha?: string;
}

function pagePath(name: string): string {
  return `/openwiki/${name}.md`;
}

function pageBody(title: string): string {
  return [
    "---",
    "type: Guide",
    `title: ${title}`,
    "description: 快照缓存与淘汰机制概览",
    "tags: [snapshot, cache]",
    "---",
    "",
    `# ${title}`,
    "",
    "旧快照被淘汰时，下一次读取会从当前状态重新构建。",
    "SnapshotCache 负责缓存与淘汰审批快照。",
    "",
  ].join("\n");
}

/** The research lesson every flow starts from; exported so a test can patch it. */
export function researchLessonBody(options: {
  codeId: string;
  designId: string | null;
  sourcePath: string;
}): Record<string, unknown> {
  const boundaries: Record<string, unknown>[] = [
    {
      item: "淘汰按单个货件进行",
      status: "implemented",
      limits: "不处理并发写入竞争",
      evidenceIds: [options.codeId],
    },
    {
      item: "演示环境自动批准",
      status: "demo",
      limits: "仅用于演示，不代表生产行为",
      evidenceIds: [options.codeId],
    },
    {
      item: "跨进程一致性保证",
      status: "unknown",
      limits: "现有证据无法确认",
      evidenceIds: [],
    },
  ];
  const statements: Record<string, unknown>[] = [
    {
      id: "st_code",
      label: "code_fact",
      text: "SnapshotCache.evict 会删除对应货件的缓存条目。",
      evidenceIds: [options.codeId],
    },
  ];
  const evidence = [options.codeId];

  if (options.designId !== null) {
    boundaries.push({
      item: "缓存持久化到外部存储",
      status: "planned",
      limits: "决策记录只描述了重新校验要求",
      evidenceIds: [options.designId],
    });
    statements.push({
      id: "st_design",
      label: "recorded_design_rationale",
      text: "决策记录要求在下一次读取时重新校验审批结果。",
      evidenceIds: [options.designId],
    });
    evidence.push(options.designId);
  }

  return {
    scenario: {
      id: "sc_snapshot_eviction",
      kind: "library_interface",
      inputs: ["shipment_id"],
      userAction: "调用缓存读取审批快照",
      observableResult: "读取到与当前状态一致的新快照",
      isExample: true,
    },
    overview: [
      {
        moduleId: "src/lmp/state",
        responsibility: "缓存并按需淘汰审批快照",
        inputs: ["shipment_id"],
        outputs: ["approval snapshot"],
      },
    ],
    plainExplanation: [
      {
        mechanismId: "m_evict",
        text: "缓存满了就丢掉旧快照，下一次读取会重新构建。",
      },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_evict",
        terms: [{ zh: "淘汰", en: "evict", symbol: "evict" }],
        text: "调用 evict 从内部字典删除货件条目。",
      },
    ],
    choices: [
      {
        decision: "使用进程内字典缓存快照",
        current: "进程内字典缓存",
        alternatives: [
          {
            option: "外部共享缓存",
            whenItFits: "多个进程需要共享同一份快照时",
            cost: "引入额外网络依赖与失效复杂度",
            evidenceIds: [options.codeId],
          },
        ],
        evidenceIds: [options.codeId],
      },
    ],
    choicesOmittedReason: null,
    boundaries,
    statements,
    evidence,
    diagram: {
      kind: "component",
      mermaid: `flowchart LR\n  n1["${options.sourcePath}"]`,
      nodes: [
        {
          id: "n1",
          label: options.sourcePath,
          evidenceIds: [options.codeId],
          status: "observed",
        },
      ],
      edges: [],
    },
    coverageGaps: [],
  };
}

function changeLesson(options: {
  codeId: string;
  commitSha: string;
}): Record<string, unknown> {
  return {
    scenario: {
      id: "sc_change",
      kind: "library_interface",
      inputs: ["shipment_id"],
      userAction: "读取变更后的审批路径",
      observableResult: "返回新的审批结果",
      isExample: true,
    },
    overview: [
      {
        moduleId: "src",
        responsibility: "处理审批流程变更",
        inputs: ["shipment_id"],
        outputs: ["approval result"],
      },
    ],
    plainExplanation: [
      { mechanismId: "m_change", text: "变更调整了审批路径的行为。" },
    ],
    technicalExplanation: [
      {
        mechanismId: "m_change",
        terms: [{ zh: "变更", en: "change", symbol: "change" }],
        text: "提交修改了审批相关的实现。",
      },
    ],
    choices: [],
    choicesOmittedReason: "变更范围较小，没有可比较的实现选择。",
    boundaries: [
      {
        item: "行为变更已实现",
        status: "implemented",
        limits: "只覆盖本次提交涉及的文件",
        evidenceIds: [options.codeId],
      },
    ],
    statements: [
      {
        id: "st_change",
        label: "code_fact",
        text: "本次提交修改了审批路径的实现。",
        evidenceIds: [options.codeId],
      },
    ],
    evidence: [options.codeId],
    diagram: {
      kind: "timeline",
      mermaid: "timeline\n  section 版本\n  变更前 -> 变更后",
      nodes: [
        {
          id: "n1",
          label: "变更后的实现",
          evidenceIds: [options.codeId],
          status: "observed",
        },
      ],
      edges: [],
    },
    coverageGaps: [],
    behaviorChange: { before: "旧的审批路径", after: "新的审批路径" },
    affectedModules: [{ moduleId: "src", effect: "审批实现调整" }],
    keyTechnologies: ["Python"],
    alternatives: [],
    unverifiedEffects: [],
    omittedReasons: {
      alternatives: "没有可比较的替代方案。",
      unverifiedEffects: "未观察到未验证影响。",
    },
  };
}

/**
 * A complete script set: planner → one page worker per page → the research
 * lesson. Every call terminates the worker loop with an empty-content step
 * after its tool call, which is how a real agent ends a turn.
 */
export function generationScripts(
  options: GenerationScriptOptions,
): ScriptFile {
  const pages = ["quickstart", ...(options.extraPages ?? [])];
  const codeId = sourceIdOf(
    options.sourcePath,
    options.commitSha,
    options.lines,
  );
  const designId =
    options.designPath === undefined
      ? null
      : sourceIdOf(options.designPath, options.commitSha, null);

  const scripts: ScriptEntry[] = [
    {
      workerKind: "planner",
      occurrence: 1,
      steps: [
        {
          toolCalls: [
            {
              name: "submit_plan",
              args: {
                pages: pages.map((name) => ({
                  path: pagePath(name),
                  title: name === "quickstart" ? "Quickstart" : name,
                  purpose: "说明快照缓存的淘汰机制",
                  seedPaths: [options.sourcePath],
                })),
                deletePages: [],
              },
            },
          ],
        },
      ],
    },
    {
      workerKind: "planner",
      occurrence: 2,
      steps: [{ content: "" }],
    },
  ];

  for (const name of pages) {
    const resource =
      options.lines === null
        ? `repo://${options.sourcePath}`
        : `repo://${options.sourcePath}#L${options.lines.start}-L${options.lines.end}`;
    scripts.push(
      {
        workerKind: "page",
        pagePath: name,
        occurrence: 1,
        steps: [
          {
            toolCalls: [
              {
                name: "write_file",
                args: {
                  path: pagePath(name),
                  content: pageBody(
                    name === "quickstart" ? "Quickstart" : name,
                  ),
                },
              },
            ],
          },
        ],
      },
      {
        workerKind: "page",
        pagePath: name,
        occurrence: 2,
        steps: [
          {
            toolCalls: [
              {
                name: "submit_page",
                args: {
                  claims: claimsFor(resource, options.designPath),
                },
              },
            ],
          },
        ],
      },
      {
        workerKind: "page",
        pagePath: name,
        occurrence: 3,
        steps: [{ content: "" }],
      },
    );
  }

  const lesson =
    options.lessonOverride ??
    JSON.stringify(
      options.lessonPatch === undefined
        ? researchLessonBody({
            codeId,
            designId,
            sourcePath: options.sourcePath,
          })
        : {
            ...researchLessonBody({
              codeId,
              designId,
              sourcePath: options.sourcePath,
            }),
            ...options.lessonPatch,
          },
    );
  scripts.push({
    workerKind: "lesson",
    occurrence: 1,
    steps: [{ content: lesson }],
  });

  if (options.includeChange === true) {
    const changeCommit = options.changeCommitSha ?? options.commitSha;
    const changeId = sourceIdOf(options.sourcePath, changeCommit, null);
    scripts.push({
      workerKind: "change",
      occurrence: 1,
      steps: [
        {
          content: JSON.stringify(
            changeLesson({ codeId: changeId, commitSha: changeCommit }),
          ),
        },
      ],
    });
  }

  return { scripts };
}

/** The page's claims: always one code fact, plus the design fact when known. */
function claimsFor(
  resource: string,
  designPath: string | undefined,
): { statement: string; evidence: { resource: string }[] }[] {
  const claims = [
    {
      statement: "快照缓存实现按货件淘汰，并在下一次读取时重建。",
      evidence: [{ resource }],
    },
  ];
  if (designPath !== undefined) {
    claims.push({
      statement: "决策记录要求在下一次读取时重新校验审批结果。",
      evidence: [{ resource: `repo://${designPath}` }],
    });
  }
  return claims;
}

export interface QaScriptOptions {
  /** Citations the answer returns (source + owning generation). */
  citations: { sourceId: string; generationId?: string }[];
  answer?: string;
  conclusion?: string;
  /** Tools to call before the final answer; `read_snapshot_file` by default. */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  notCovered?: string[];
}

/** A QA turn: optional read-only tools, then one JSON answer. */
export function qaScripts(options: QaScriptOptions): ScriptFile {
  const tools = options.toolCalls ?? [];
  if (tools.length === 0) {
    return {
      scripts: [
        {
          workerKind: "lesson",
          occurrence: 1,
          steps: [{ content: JSON.stringify(answerPayload(options)) }],
        },
      ],
    };
  }
  return {
    scripts: [
      {
        workerKind: "lesson",
        occurrence: 1,
        steps: [{ toolCalls: tools }],
      },
      {
        workerKind: "lesson",
        occurrence: 2,
        steps: [{ content: JSON.stringify(answerPayload(options)) }],
      },
    ],
  };
}

function answerPayload(options: QaScriptOptions): Record<string, unknown> {
  return {
    answer:
      options.answer ??
      "项目如何使用：SnapshotCache 在淘汰时删除条目，下一次读取会重建。" +
        " 技术如何工作：缓存淘汰是通用机制。 外部背景：source_missing（未登记外部资料）。",
    conclusion: options.conclusion ?? "code_fact",
    citations: options.citations,
    notCovered: options.notCovered ?? ["外部背景 source_missing"],
  };
}

// ── filesystem assertions ───────────────────────────────────────────────────

/** Recursive relative path → sha256 of every regular file below `root`. */
export function treeManifest(root: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (relative === ".git" || relative.startsWith(".git/")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        manifest[relative] = createHash("sha256")
          .update(fs.readFileSync(absolute))
          .digest("hex");
      }
    }
  };
  walk(root, "");
  return manifest;
}

/** True when `needle` appears in any regular file below `root`. */
export function treeContains(root: string, needle: string): boolean {
  let found = false;
  const walk = (directory: string): void => {
    if (found) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        try {
          if (fs.readFileSync(absolute, "utf8").includes(needle)) found = true;
        } catch {
          // Binary or unreadable files cannot hold the canary in text form.
        }
      }
    }
  };
  walk(root);
  return found;
}

/** Reads one value from the data directory's SQLite file via the test driver. */
export function withDatabase<T>(
  dataDir: string,
  fn: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(path.join(dataDir, "db", "codetrail.sqlite"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
