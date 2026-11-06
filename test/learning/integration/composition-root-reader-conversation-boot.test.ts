/**
 * Merge boundary: `composition-root` (issue 27) ↔ the phase B learner surface
 * (issue 28).
 *
 * The composition root owns *how* the server comes up: it builds the single
 * `AppDeps` graph, repairs restart leftovers (`recoverInterrupted` +
 * `cancelStreaming`) before the listener exists, mounts the static reader/QA
 * UI and every API route module, and binds loopback only. The phase B gate owns
 * *what* a learner must see: a Chinese reader page whose plain/technical
 * layers share `mechanismId`s, a coverage gap rendered as incomplete, and a
 * conversation whose streamed answer survives a restart as `cancelled`.
 *
 * Neither branch tests the other's half end to end: b-gate builds its server by
 * hand, and cli-boot only probes `/api/health`, `/api/jobs/:id` and
 * `/api/conversations/:id`. This suite drives the *built* composition root with
 * a data directory seeded exactly the way the B gate seeds its fixture, so a
 * wiring regression between the two merges is observable.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createAppDeps } from "../../../src/learning/api/cli.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { makeJob, makeMessage } from "../store/helpers.ts";
import { clone, researchLesson } from "../helpers/lesson-sample.ts";
import {
  cleanupTempDirs,
  publishGeneration,
  REPO_ID,
  PROJECT_ID,
  COMMIT_A,
} from "../qa/qa-helpers.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CLI = path.join(ROOT, "dist", "learning", "api", "cli.js");
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)$/u;

const AT = "2026-01-01T00:00:00.000Z";
const GENERATION = "g_boot_reader";
const LESSON = "l_boot_reader";
const CONVERSATION = "c_boot_reader";
const STREAMING_MESSAGE = "m_boot_streaming";
const RUNNING_JOB = "j_boot_running";
const SOURCE = "s_boot_evict";

/** The frozen `AppDeps` contract; a missing or extra port is a wiring bug. */
const APP_DEPS_KEYS = [
  "answers",
  "clock",
  "conversations",
  "db",
  "external",
  "jobRunner",
  "model",
  "paths",
  "publisher",
  "registry",
  "removal",
  "repos",
  "retriever",
  "session",
  "snapshotService",
  "usage",
  "watch",
] as const;

const tempDirs: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface BootedServer {
  child: ReturnType<typeof spawn>;
  url: string;
  port: number;
  stdout: string;
  exit: Promise<ExitResult>;
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-merge-boot-"));
  tempDirs.push(dir);
  return dir;
}

function waitForExit(
  exit: Promise<ExitResult>,
  timeoutMs = 15_000,
): Promise<ExitResult> {
  return new Promise<ExitResult>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not exit within ${timeoutMs} ms`)),
      timeoutMs,
    );
    void exit.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function boot(dataDir: string): Promise<BootedServer> {
  const child = spawn(process.execPath, [CLI], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODETRAIL_DATA_DIR: dataDir,
      CODETRAIL_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  const exit = new Promise<ExitResult>((resolve) => {
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });

  return new Promise<BootedServer>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `built entry printed no URL within 30 s\nstderr:\n${stderr}\nstdout:\n${stdout}`,
          ),
        ),
      30_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        const match = URL_PATTERN.exec(line);
        if (match === null) continue;
        clearTimeout(timer);
        resolve({
          child,
          url: line,
          port: Number(match[1]),
          get stdout() {
            return stdout;
          },
          exit,
        });
        return;
      }
    });
    void exit.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(
        new Error(
          `built entry exited before printing a URL (code ${String(code)}, ` +
            `signal ${String(signal)})\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    });
  });
}

async function stop(server: BootedServer): Promise<ExitResult> {
  server.child.kill("SIGTERM");
  return waitForExit(server.exit);
}

async function getJson(
  baseUrl: string,
  pathname: string,
  cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text),
  };
}

async function getHtml(
  baseUrl: string,
  pathname: string,
  cookie: string,
): Promise<{ status: number; contentType: string; html: string }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { cookie },
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    html: await response.text(),
  };
}

async function bootstrap(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/session/bootstrap`);
  await response.text();
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const cookie = headers.find((header) =>
    header.startsWith("codetrail_session="),
  );
  if (cookie === undefined) throw new Error("bootstrap did not mint a session");
  return cookie.split(";")[0];
}

/** A research lesson with the B gate's mechanism pairing on both layers. */
function gateLesson(): Record<string, unknown> {
  const lesson = clone(researchLesson());
  lesson.lessonId = LESSON;
  lesson.generationId = GENERATION;
  lesson.context = {
    repoId: REPO_ID,
    commitSha: COMMIT_A,
    generationId: GENERATION,
    scenarioId: "sc_boot",
    moduleIds: ["src/lmp/state"],
  };
  lesson.scenario = {
    ...(lesson.scenario as Record<string, unknown>),
    id: "sc_boot",
  };
  lesson.plainExplanation = [
    { mechanismId: "m_evict", text: "旧快照被淘汰时，缓存先摘掉指针。" },
    { mechanismId: "m_rebuild", text: "下一次读取会按当前状态重建快照。" },
  ];
  lesson.technicalExplanation = [
    {
      mechanismId: "m_evict",
      terms: [
        { zh: "快照缓存", en: "snapshot cache", symbol: "SnapshotCache" },
      ],
      text: "SnapshotCache.evict 先删除映射，再释放条目。",
    },
    {
      mechanismId: "m_rebuild",
      terms: [{ zh: "重建", en: "rebuild" }],
      text: "重建路径重新读取源数据，不复用被淘汰的条目。",
    },
  ];
  lesson.evidence = [SOURCE];
  lesson.choices = [];
  lesson.choicesOmittedReason = "只有一条实现路径，没有可比较的替代方案。";
  lesson.boundaries = [
    {
      item: "淘汰只影响内存缓存",
      status: "implemented",
      limits: "不删除已封存的生成版本",
      evidenceIds: [SOURCE],
    },
  ];
  lesson.statements = [
    {
      id: "st_boot",
      label: "code_fact",
      text: "evict 删除缓存条目。",
      evidenceIds: [SOURCE],
    },
  ];
  lesson.diagram = {
    kind: "component",
    mermaid: 'flowchart LR\n  n1["SnapshotCache"]',
    nodes: [
      {
        id: "n1",
        label: "SnapshotCache",
        evidenceIds: [SOURCE],
        status: "observed",
      },
    ],
    edges: [],
  };
  lesson.checks = { structural: "pass", evidence: "pass", semantic: "pass" };
  return lesson;
}

/**
 * Seeds the data directory the way the B gate does (published generation +
 * lesson JSON) *and* leaves the restart leftovers the composition root repairs
 * (a `running` job and a `streaming` message).
 */
function seedDataDir(dataDir: string): void {
  const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dataDir });
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  fs.mkdirSync(paths.knowledge, { recursive: true });
  const db = openDatabase({ file: paths.db });
  try {
    migrate(db);
    const repos = createRepositories(db);

    publishGeneration(
      { repos },
      {
        generationId: GENERATION,
        repoId: REPO_ID,
        projectId: PROJECT_ID,
        commitSha: COMMIT_A,
        contentDir: path.join(paths.knowledge, GENERATION),
        sources: [
          {
            sourceId: SOURCE,
            kind: "repo",
            path: "src/lmp/state/snapshot_cache.py",
            lines: { start: 1, end: 24 },
          },
        ],
        lessons: [{ lessonId: LESSON, title: "旧快照淘汰" }],
        files: {
          [`lessons/${LESSON}.json`]: JSON.stringify(gateLesson()),
          "coverage.json": JSON.stringify({
            generationId: GENERATION,
            commitSha: COMMIT_A,
            complete: false,
            analyzed: [{ path: "src/lmp/state/snapshot_cache.py", bytes: 640 }],
            gaps: [{ path: "vendor/legacy", reason: "excluded", bytes: 12 }],
            counts: { totalFiles: 2, analyzedFiles: 1, excludedFiles: 1 },
            languages: { byLanguage: [], preferredCoverageOk: false },
          }),
        },
      },
    );

    repos.conversations.insert({
      conversationId: CONVERSATION as never,
      generationIds: [GENERATION as never],
      at: AT,
    });
    repos.conversations.insertMessage(
      makeMessage({
        messageId: STREAMING_MESSAGE as never,
        conversationId: CONVERSATION as never,
        role: "assistant",
        content: "被中断的半截回答",
        status: "streaming",
        answerPhase: "streaming",
      }),
    );
    repos.jobs.insert(
      makeJob({
        jobId: RUNNING_JOB as never,
        dedupeKey: "dk_boot_running",
        state: "running",
        attempt: 1,
        startedAt: AT,
      }),
    );
  } finally {
    db.close();
  }
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`missing ${CLI}; run \`pnpm run build\``);
  }
});

afterEach(async () => {
  for (const child of [...children]) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 5_000);
    });
  }
});

afterAll(() => {
  cleanupTempDirs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createAppDeps — the single dependency root", () => {
  test("constructs the frozen AppDeps contract under CODETRAIL_DATA_DIR without listening", async () => {
    const dataDir = makeTempDir();
    const deps = await createAppDeps({
      CODETRAIL_DATA_DIR: dataDir,
      CODETRAIL_NOW: AT,
    });
    try {
      expect(Object.keys(deps).sort()).toEqual([...APP_DEPS_KEYS].sort());
      expect(deps.paths.root).toBe(fs.realpathSync(dataDir));
      expect(fs.existsSync(deps.paths.db)).toBe(true);
      expect(deps.model).toBeNull();
      expect(typeof deps.jobRunner.recoverInterrupted).toBe("function");
      expect(typeof deps.repos.conversations.cancelStreaming).toBe("function");
    } finally {
      deps.watch.stop();
      deps.db.close();
    }
  });
});

describe("built composition root — phase B reader and restart-safe conversation", () => {
  test("serves the reader, repairs the streamed message and drains on SIGTERM", async () => {
    const dataDir = makeTempDir();
    seedDataDir(dataDir);

    const server = await boot(dataDir);
    try {
      // First request of the process: health is public and proves the listener.
      const health = await getJson(server.url, "/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: "ok" });
      expect(
        typeof (health.body as { upstreamCommit?: unknown }).upstreamCommit,
      ).toBe("string");

      // Every non-public route still needs the browser session (composition
      // root mounts the same auth seam the B gate asserts).
      const unauthenticated = await getJson(server.url, "/api/projects");
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body).toMatchObject({
        error: { code: "unauthorized" },
      });

      const cookie = await bootstrap(server.url);

      const reader = await getHtml(
        server.url,
        `/learn/reader?generation=${GENERATION}`,
        cookie,
      );
      expect(reader.status).toBe(200);
      expect(reader.contentType).toContain("text/html");
      for (const testid of [
        "reader-nav",
        "reader-lesson",
        "reader-qa",
        "lesson-plain",
        "lesson-technical",
        "lesson-choices",
        "lesson-boundaries",
        "lesson-evidence",
        "diagram-component",
        "coverage-gaps",
      ]) {
        expect(
          reader.html.split(`data-testid="${testid}"`).length - 1,
          `${testid} must be rendered exactly once`,
        ).toBe(1);
      }
      // Same mechanism ids on both layers, and the gap is never claimed as
      // complete — the two properties the B gate pins on its own harness.
      expect(reader.html.split('data-mechanism-id="m_evict"').length - 1).toBe(
        2,
      );
      expect(
        reader.html.split('data-mechanism-id="m_rebuild"').length - 1,
      ).toBe(2);
      expect(reader.html).toContain('data-complete="false"');
      expect(reader.html).toContain(COMMIT_A.slice(0, 7));

      // Boot recovery ran before listen: the very first conversation read
      // observes the normalisation the phase B gate requires after a restart.
      const conversation = await getJson(
        server.url,
        `/api/conversations/${CONVERSATION}`,
        cookie,
      );
      expect(conversation.status).toBe(200);
      const messages = (
        conversation.body as {
          messages: {
            messageId: string;
            status: string;
            answerPhase: string;
          }[];
        }
      ).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        messageId: STREAMING_MESSAGE,
        status: "cancelled",
        answerPhase: "cancelled",
      });

      const job = await getJson(server.url, `/api/jobs/${RUNNING_JOB}`, cookie);
      expect(job.status).toBe(200);
      expect(job.body).toMatchObject({
        state: "interrupted",
        errorCode: "interrupted",
      });

      const lessons = await getJson(
        server.url,
        `/api/generations/${GENERATION}/lessons`,
        cookie,
      );
      expect(lessons.status).toBe(200);

      const coverage = await getJson(
        server.url,
        `/api/generations/${GENERATION}/coverage`,
        cookie,
      );
      expect(coverage.status).toBe(200);
      expect(coverage.body).toMatchObject({ complete: false });

      // Exactly one loopback URL was printed.
      expect(
        server.stdout
          .split("\n")
          .filter((line) => URL_PATTERN.test(line.trim())).length,
      ).toBe(1);
    } finally {
      const exit = await stop(server);
      expect(exit).toMatchObject({ code: 0, signal: null });
    }
  });
});
