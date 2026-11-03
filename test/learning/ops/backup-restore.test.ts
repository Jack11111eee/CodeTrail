import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionStore } from "../../../src/learning/api/auth.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { conversationsModule } from "../../../src/learning/api/routes/conversations.ts";
import { generationsRoutes } from "../../../src/learning/api/routes/generations.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import {
  resolveDataPaths,
  ensureDataDir,
  knowledgePath,
  mirrorPath,
} from "../../../src/learning/config/paths.ts";
import type {
  AppDeps,
  GenerationId,
  LessonId,
  RepoId,
  SourceId,
  RunningServer,
} from "../../../src/learning/contracts/index.ts";
import {
  repoIdFromIdentity,
  sliceHash,
} from "../../../src/learning/contracts/index.ts";
import { createExternalDocService } from "../../../src/learning/evidence/external.ts";
import {
  createSourceRegistry,
  repoSourceId,
} from "../../../src/learning/evidence/registry.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { createConversationService } from "../../../src/learning/qa/conversations.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";
import { startHarness } from "../helpers/http-client.ts";
import { researchLesson } from "../helpers/lesson-sample.ts";

/**
 * AC-OPS-03 / AC-SEC-09.
 *
 * Seeds a real data directory (real Git mirror, immutable snapshot worktree,
 * published generation with a lesson + repo source, and a conversation), takes
 * a backup, restores into a **fresh empty data directory**, and then proves
 * the restored state by reading it over HTTP — lesson list/detail, conversation
 * messages and a source link. The source link is the load-bearing assertion:
 * it only resolves if the mirror bundle and detached worktree were rebuilt and
 * the absolute path columns were rewritten.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BACKUP_SCRIPT = path.join(REPO_ROOT, "scripts", "backup.mjs");
const RESTORE_SCRIPT = path.join(REPO_ROOT, "scripts", "restore.mjs");
const NOW = "2026-01-01T00:00:00.000Z";
const CANARY = "ghp_backup_canary_0123456789abcdef";
const CONTENT = "export const answer = 42;\n";

const tempDirs: string[] = [];
const servers: RunningServer[] = [];
const dbs: { close: () => void }[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-backup-"));
  tempDirs.push(dir);
  return dir;
}

/** Snapshot worktrees are deliberately read-only; make them removable first. */
function makeWritable(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeWritable(child);
      try {
        fs.chmodSync(child, 0o755);
      } catch {
        // Best effort.
      }
    } else {
      try {
        fs.chmodSync(child, 0o644);
      } catch {
        // Best effort.
      }
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // Best effort.
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // A test may have closed it already before spawning the backup script.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.platform() === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(absolute, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out.sort();
}

interface Fixture {
  base: string;
  dataDir: string;
  restoredDir: string;
  backupDir: string;
  generationId: GenerationId;
  lessonId: LessonId;
  sourceId: SourceId;
  conversationId: string;
  repoId: RepoId;
  commitSha: string;
}

async function seed(): Promise<Fixture> {
  const base = makeTempDir();
  const dataDir = path.join(base, "data");
  const restoredDir = path.join(base, "restored");
  const backupDir = path.join(base, "backup");
  const sourceRepo = path.join(base, "source-repo");
  fs.mkdirSync(sourceRepo, { recursive: true });

  git(["init", "--quiet"], sourceRepo);
  git(["config", "user.email", "test@example.com"], sourceRepo);
  git(["config", "user.name", "Backup Test"], sourceRepo);
  fs.mkdirSync(path.join(sourceRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(sourceRepo, "src", "index.ts"), CONTENT, "utf8");
  git(["add", "."], sourceRepo);
  git(["commit", "--quiet", "-m", "init"], sourceRepo);
  const commitSha = git(["rev-parse", "HEAD"], sourceRepo);

  const paths = resolveDataPaths({
    ...process.env,
    CODETRAIL_DATA_DIR: dataDir,
  });
  await ensureDataDir(paths);

  const clock = createClock(NOW);
  const db = openDatabase({ file: paths.db, clock });
  dbs.push(db);
  migrate(db);
  const repos = createRepositories(db);

  const repoId = repoIdFromIdentity(`local:${sourceRepo}`);
  const mirror = mirrorPath(paths, repoId);
  git(["clone", "--mirror", sourceRepo, mirror], base);
  repos.repos.upsert({
    repoId,
    identity: `local:${sourceRepo}`,
    kind: "local",
    mirrorPath: mirror,
    remoteUrl: null,
    createdAt: NOW,
  });

  const snapshotService = createSnapshotService({ paths, repos, clock });
  await snapshotService.ensure(repoId, commitSha);

  const generationId = "g_backuptest" as GenerationId;
  const lessonId = "l_backuptest" as LessonId;
  const sourceId = repoSourceId("src/index.ts", commitSha, null);
  const knowledgeDir = knowledgePath(paths, generationId);
  fs.mkdirSync(path.join(knowledgeDir, "lessons"), { recursive: true });

  const lesson = researchLesson();
  lesson.lessonId = lessonId;
  lesson.generationId = generationId;
  lesson.context = {
    repoId,
    commitSha,
    generationId,
    scenarioId: "sc_backuptest",
    moduleIds: ["src"],
  };
  lesson.evidence = [sourceId];
  const lessonFile = path.join(knowledgeDir, "lessons", `${lessonId}.json`);
  fs.writeFileSync(lessonFile, `${JSON.stringify(lesson, null, 2)}\n`, "utf8");

  repos.generations.insertPublished({
    generationId,
    cacheKey: "sha256:backup-cache",
    repoId,
    projectId: null,
    commitSha,
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: normalizeScope().hash,
    configHash: "sha256:config",
    promptTemplateVersion: "lp1",
    preferencesVersion: 1,
    upstreamVersion: "0.7.2",
    status: "published",
    contentDir: knowledgeDir,
    sealedTreeHash: "sha256:sealed",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: NOW,
    publishedAt: NOW,
  });

  repos.lessons.insertMany([
    {
      lessonId,
      generationId,
      kind: "research",
      title: "备份测试讲解",
      relPath: `lessons/${lessonId}.json`,
      jsonSha256: sha256File(lessonFile),
      publishedAt: NOW,
    },
  ]);
  repos.sources.insertMany([
    {
      generationId,
      sourceId,
      kind: "repo",
      commitSha,
      payloadJson: JSON.stringify({
        sourceId,
        kind: "repo",
        generationId,
        repoId,
        commitSha,
        path: "src/index.ts",
        lines: null,
        contentHash: sliceHash(CONTENT),
      }),
      contentHash: sliceHash(CONTENT),
    },
  ]);

  const conversations = createConversationService({ db, repos, clock });
  const conversation = await conversations.create({
    generationIds: [generationId],
  });
  await conversations.appendUserMessage(
    conversation.conversationId,
    "这个文件返回什么？",
    null,
  );

  // A canary the archive must never carry: it lives only in credential/session/
  // log files, all three of which the backup excludes and scans for.
  fs.writeFileSync(
    paths.credentials,
    JSON.stringify({ kind: "token", token: CANARY, login: null }),
    { mode: 0o600 },
  );
  fs.writeFileSync(paths.session, JSON.stringify({ token: CANARY }), {
    mode: 0o600,
  });
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.writeFileSync(
    path.join(paths.logs, "codetrail.jsonl"),
    `${JSON.stringify({ event: "boot", level: "info", token: CANARY })}\n`,
    "utf8",
  );

  db.close();
  return {
    base,
    dataDir,
    restoredDir,
    backupDir,
    generationId,
    lessonId,
    sourceId,
    conversationId: conversation.conversationId,
    repoId,
    commitSha,
  };
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

function runBackup(fixture: Fixture) {
  const result = runScript(BACKUP_SCRIPT, [
    "--out",
    fixture.backupDir,
    "--data-dir",
    fixture.dataDir,
    "--json",
  ]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    outDir: string;
    bytes: number;
    files: { path: string; sha256: string; bytes: number }[];
  };
}

function runRestore(fixture: Fixture, target = fixture.restoredDir) {
  return runScript(RESTORE_SCRIPT, [
    "--from",
    fixture.backupDir,
    "--data-dir",
    target,
    "--json",
  ]);
}

describe("backup and restore", () => {
  it("archives the database, knowledge and git objects with no token canary", async () => {
    const fixture = await seed();
    const backup = runBackup(fixture);

    for (const required of ["manifest.json", "db/codetrail.sqlite"]) {
      expect(fs.existsSync(path.join(fixture.backupDir, required))).toBe(true);
    }
    expect(fs.existsSync(path.join(fixture.backupDir, "knowledge"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(fixture.backupDir, "git-objects", `${fixture.repoId}.bundle`),
      ),
    ).toBe(true);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture.backupDir, "manifest.json"), "utf8"),
    ) as {
      schemaVersion: number;
      sourceRoot: string;
      files: { path: string }[];
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sourceRoot).toBe(fs.realpathSync(fixture.dataDir));
    const listed = manifest.files.map((file) => file.path);
    expect(listed).toContain("db/codetrail.sqlite");
    expect(listed.some((file) => file.startsWith("knowledge/"))).toBe(true);
    expect(listed).toContain(`git-objects/${fixture.repoId}.bundle`);

    // Every manifest hash matches the bytes on disk.
    for (const file of backup.files) {
      if (file.path === "manifest.json") continue;
      expect(
        `sha256:${sha256File(path.join(fixture.backupDir, file.path))}`,
      ).toBe(file.sha256);
    }

    // No archive file carries the token canary.
    for (const relative of listFiles(fixture.backupDir)) {
      const text = fs.readFileSync(
        path.join(fixture.backupDir, relative),
        "utf8",
      );
      expect(text).not.toContain(CANARY);
    }
  });

  it("restores into an empty data dir and every read route works over HTTP", async () => {
    const fixture = await seed();
    runBackup(fixture);
    const restored = runRestore(fixture);
    expect(restored.status, restored.stderr).toBe(0);

    const restoredPaths = resolveDataPaths({
      ...process.env,
      CODETRAIL_DATA_DIR: fixture.restoredDir,
    });
    const clock = createClock(NOW);
    const db = openDatabase({ file: restoredPaths.db, clock });
    dbs.push(db);
    migrate(db);
    const repos = createRepositories(db);

    // Absolute path columns were rewritten off the old root.
    expect(
      repos.repos
        .byId(fixture.repoId)
        ?.mirrorPath.startsWith(restoredPaths.root),
    ).toBe(true);
    expect(
      repos.snapshots
        .byCommit(fixture.repoId, fixture.commitSha)
        ?.worktreePath.startsWith(restoredPaths.root),
    ).toBe(true);
    expect(
      repos.generations
        .byId(fixture.generationId)
        ?.contentDir.startsWith(restoredPaths.root),
    ).toBe(true);

    const conversations = createConversationService({ db, repos, clock });
    const snapshotService = createSnapshotService({
      paths: restoredPaths,
      repos,
      clock,
    });
    const external = createExternalDocService({ paths: restoredPaths, clock });
    const registry = createSourceRegistry({
      clock,
      sources: repos.sources,
      generations: repos.generations,
    });
    const session = createSessionStore(restoredPaths);
    const deps = {
      paths: restoredPaths,
      clock,
      db,
      repos,
      conversations,
      snapshotService,
      external,
      registry,
      session,
      model: null,
      removal: { state: () => "active" },
    } as unknown as AppDeps;

    registerRouteModule(generationsRoutes);
    registerRouteModule(conversationsModule);
    const server = await createLearningServer({
      paths: restoredPaths,
      port: 0,
      clock,
      deps,
    });
    servers.push(server);
    const harness = await startHarness({ baseUrl: server.url });

    const lessons = await harness.request(
      `/api/generations/${fixture.generationId}/lessons`,
    );
    expect(lessons.status).toBe(200);
    const lessonList = lessons.json as {
      lessons: { lessonId: string; title: string }[];
    };
    expect(lessonList.lessons.map((lesson) => lesson.lessonId)).toContain(
      fixture.lessonId,
    );

    const detail = await harness.request(
      `/api/generations/${fixture.generationId}/lessons/${fixture.lessonId}`,
    );
    expect(detail.status).toBe(200);
    expect(
      (detail.json as { lesson: { lessonId: string } }).lesson.lessonId,
    ).toBe(fixture.lessonId);

    const messages = await harness.request(
      `/api/conversations/${fixture.conversationId}/messages`,
    );
    expect(messages.status).toBe(200);
    const messageList = messages.json as {
      messages: { content: string }[];
    };
    expect(messageList.messages.map((message) => message.content)).toContain(
      "这个文件返回什么？",
    );

    // The source link only resolves when the mirror bundle and detached
    // worktree were rebuilt at the restored paths.
    const source = await harness.request(
      `/api/generations/${fixture.generationId}/sources/${fixture.sourceId}`,
    );
    expect(source.status).toBe(200);
    const sourceView = source.json as { content: string; availability: string };
    expect(sourceView.availability).toBe("available");
    expect(sourceView.content).toContain("export const answer = 42;");

    for (const response of [lessons, detail, messages, source]) {
      expect(response.text).not.toContain(CANARY);
    }
  });

  it("refuses a non-empty restore target", async () => {
    const fixture = await seed();
    runBackup(fixture);
    const target = path.join(fixture.base, "occupied");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "not empty", "utf8");

    const result = runRestore(fixture, target);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("target_not_empty");
  });
});
