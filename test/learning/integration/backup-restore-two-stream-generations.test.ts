/**
 * Integration merge boundary: gate-c dual-stream generations × ops-scripts
 * backup / restore / gc.
 *
 * Phase C produces two independent records for the same repository: a
 * default-branch generation pinned to the main head and a PR-preview
 * generation pinned to the PR head with the merge-base as its comparison base.
 * The ops scripts only add value if those records survive a backup/restore
 * byte-for-byte: both knowledge trees, both generation rows (including
 * `commit_sha` and `comparison_base_sha`), the change events and both streams'
 * cursors. GC then has to keep both published trees and reclaim only the
 * unreferenced one.
 *
 * The archive is taken with the real `scripts/backup.mjs` / `restore.mjs` and
 * the collector with the real `scripts/gc.mjs`, so this exercises the merged
 * operator surface rather than the repositories in isolation.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

import { runGc } from "../../../scripts/gc.mjs";
import {
  ensureDataDir,
  knowledgePath,
  mirrorPath,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type {
  ChangeEventId,
  GenerationId,
  LessonId,
  ProjectId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import {
  emptyCursor,
  repoIdFromIdentity,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const BACKUP_SCRIPT = path.join(ROOT, "scripts", "backup.mjs");
const RESTORE_SCRIPT = path.join(ROOT, "scripts", "restore.mjs");
const NOW = "2026-02-01T00:00:00.000Z";
const CANARY = "ghp_two_stream_backup_canary_0123456789";
const MAIN_STREAM = "default_branch";
const PR_STREAM = "pull_request";

const tempDirs: string[] = [];
const openDbs: { close: () => void }[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Snapshot worktrees are read-only; make the temp tree removable. */
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

function writeLesson(
  knowledgeDir: string,
  lessonId: LessonId,
  generationId: GenerationId,
  title: string,
): string {
  fs.mkdirSync(path.join(knowledgeDir, "lessons"), { recursive: true });
  const file = path.join(knowledgeDir, "lessons", `${lessonId}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ lessonId, generationId, title }, null, 2)}\n`,
    "utf8",
  );
  return file;
}

interface Seeded {
  dataDir: string;
  backupDir: string;
  restoredDir: string;
  repoId: RepoId;
  projectId: ProjectId;
  mainSha: string;
  prSha: string;
  mainGenerationId: GenerationId;
  prGenerationId: GenerationId;
  mainLessonId: LessonId;
  prLessonId: LessonId;
  mainEventId: ChangeEventId;
  prEventId: ChangeEventId;
}

async function seed(): Promise<Seeded> {
  const base = makeTempDir("codetrail-two-stream-");
  const dataDir = path.join(base, "data");
  const backupDir = path.join(base, "backup");
  const restoredDir = path.join(base, "restored");
  const sourceRepo = path.join(base, "source-repo");
  fs.mkdirSync(sourceRepo, { recursive: true });

  git(["init", "--quiet"], sourceRepo);
  git(["config", "user.email", "test@example.com"], sourceRepo);
  git(["config", "user.name", "Two Stream Test"], sourceRepo);
  fs.mkdirSync(path.join(sourceRepo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRepo, "src", "main.ts"),
    "export const main = 1;\n",
    "utf8",
  );
  git(["add", "."], sourceRepo);
  git(["commit", "--quiet", "-m", "main head"], sourceRepo);
  const mainSha = git(["rev-parse", "HEAD"], sourceRepo);

  fs.writeFileSync(
    path.join(sourceRepo, "src", "feature.ts"),
    "export const feature = 2;\n",
    "utf8",
  );
  git(["add", "."], sourceRepo);
  git(["commit", "--quiet", "-m", "feat: pr preview"], sourceRepo);
  const prSha = git(["rev-parse", "HEAD"], sourceRepo);

  const paths = resolveDataPaths({
    ...process.env,
    CODETRAIL_DATA_DIR: dataDir,
  });
  await ensureDataDir(paths);

  const clock = createClock(NOW);
  const db = openDatabase({ file: paths.db, clock });
  openDbs.push(db);
  migrate(db);
  const repos = createRepositories(db);

  const identity = `local:${sourceRepo}`;
  const repoId = repoIdFromIdentity(identity);
  const mirror = mirrorPath(paths, repoId);
  git(["clone", "--mirror", sourceRepo, mirror], base);
  repos.repos.upsert({
    repoId,
    identity,
    kind: "local",
    mirrorPath: mirror,
    remoteUrl: null,
    createdAt: NOW,
  });

  const snapshotService = createSnapshotService({ paths, repos, clock });
  await snapshotService.ensure(repoId, mainSha);
  await snapshotService.ensure(repoId, prSha);

  const projectId = "p_two_stream" as ProjectId;
  repos.projects.insert({
    projectId,
    repoId,
    kind: "local",
    displayName: "two-stream",
    remoteUrl: null,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: NOW,
    deletedAt: null,
  });

  const mainGenerationId = "g_main_stream" as GenerationId;
  const prGenerationId = "g_pr_preview" as GenerationId;
  const mainLessonId = "l_main_stream" as LessonId;
  const prLessonId = "l_pr_preview" as LessonId;

  const mainDir = knowledgePath(paths, mainGenerationId);
  const prDir = knowledgePath(paths, prGenerationId);
  const mainLessonFile = writeLesson(
    mainDir,
    mainLessonId,
    mainGenerationId,
    "default branch generation",
  );
  const prLessonFile = writeLesson(
    prDir,
    prLessonId,
    prGenerationId,
    "pull request preview generation",
  );

  repos.generations.insertPublished({
    generationId: mainGenerationId,
    cacheKey: "sha256:two-stream-main",
    repoId,
    projectId,
    commitSha: mainSha,
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: normalizeScope().hash,
    configHash: "sha256:two-stream-config",
    promptTemplateVersion: "lp1",
    preferencesVersion: 1,
    upstreamVersion: "0.7.2",
    status: "published",
    contentDir: mainDir,
    sealedTreeHash: "sha256:main-sealed",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: NOW,
    publishedAt: NOW,
  });
  repos.generations.insertPublished({
    generationId: prGenerationId,
    cacheKey: "sha256:two-stream-pr-preview",
    repoId,
    projectId,
    commitSha: prSha,
    comparisonBaseSha: mainSha,
    kind: "change",
    scopeHash: normalizeScope().hash,
    configHash: "sha256:two-stream-config",
    promptTemplateVersion: "lp1",
    preferencesVersion: 1,
    upstreamVersion: "0.7.2",
    status: "published",
    contentDir: prDir,
    sealedTreeHash: "sha256:pr-sealed",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: NOW,
    publishedAt: NOW,
  });

  repos.lessons.insertMany([
    {
      lessonId: mainLessonId,
      generationId: mainGenerationId,
      kind: "research",
      title: "default branch generation",
      relPath: `lessons/${mainLessonId}.json`,
      jsonSha256: sha256File(mainLessonFile),
      publishedAt: NOW,
    },
    {
      lessonId: prLessonId,
      generationId: prGenerationId,
      kind: "change",
      title: "pull request preview generation",
      relPath: `lessons/${prLessonId}.json`,
      jsonSha256: sha256File(prLessonFile),
      publishedAt: NOW,
    },
  ]);

  const mainSourceId = repoSourceId("src/main.ts", mainSha, null);
  const prSourceId = repoSourceId("src/feature.ts", prSha, null);
  repos.sources.insertMany([
    {
      generationId: mainGenerationId,
      sourceId: mainSourceId,
      kind: "repo",
      commitSha: mainSha,
      payloadJson: JSON.stringify({
        sourceId: mainSourceId,
        kind: "repo",
        generationId: mainGenerationId,
        repoId,
        commitSha: mainSha,
        path: "src/main.ts",
        lines: null,
        contentHash: "sha256:main-source",
      }),
      contentHash: "sha256:main-source",
    },
    {
      generationId: prGenerationId,
      sourceId: prSourceId,
      kind: "repo",
      commitSha: prSha,
      payloadJson: JSON.stringify({
        sourceId: prSourceId,
        kind: "repo",
        generationId: prGenerationId,
        repoId,
        commitSha: prSha,
        path: "src/feature.ts",
        lines: null,
        contentHash: "sha256:pr-source",
      }),
      contentHash: "sha256:pr-source",
    },
  ]);

  // `linked_event_id` is a self-referencing FK, so the rows are inserted first
  // and linked in a second statement (the production discovery transaction
  // does the same when it associates a merged PR with the main-branch event).
  const mainEventId = "ev_two_stream_main" as ChangeEventId;
  const prEventId = "ev_two_stream_pr" as ChangeEventId;
  repos.changes.insertMany([
    {
      eventId: mainEventId,
      eventKey: "ek:two-stream:main",
      repoId,
      projectId,
      streamId: MAIN_STREAM,
      streamKind: "default_branch",
      kind: "commit",
      baseSha: null,
      headSha: mainSha,
      mergeBaseSha: null,
      baseContextSha: null,
      significance: "full",
      state: "published",
      jobId: null,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: NOW,
      publishedAt: NOW,
      payload: {
        commit: { firstParent: null, associatedCommits: [] },
      },
    },
    {
      eventId: prEventId,
      eventKey: "ek:two-stream:pr",
      repoId,
      projectId,
      streamId: PR_STREAM,
      streamKind: "pull_request",
      kind: "pull_request",
      baseSha: mainSha,
      headSha: prSha,
      mergeBaseSha: mainSha,
      baseContextSha: mainSha,
      significance: "full",
      state: "published",
      jobId: null,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: NOW,
      publishedAt: NOW,
      payload: {
        pr: {
          number: 7,
          state: "open",
          merged: false,
          title: "feat: pr preview",
          headSha: prSha,
          baseHeadSha: mainSha,
          mergeBaseSha: mainSha,
          updatedAt: NOW,
          branch: "feat/pr-preview",
          baseBranch: "main",
        },
      },
    },
  ]);
  repos.changes.link({
    prEventId,
    defaultBranchEventId: mainEventId,
    relation: "supplementary",
  });

  const mainDiscovery = emptyCursor("default_branch");
  mainDiscovery.headSha = mainSha;
  mainDiscovery.branch = "main";
  mainDiscovery.lastPollAt = NOW;
  expect(
    repos.cursors.put({
      repoId,
      streamId: MAIN_STREAM,
      kind: "discovery",
      cursor: mainDiscovery,
      expectedPrevious: null,
    }),
  ).toBe(true);

  const mainPublished = emptyCursor("default_branch");
  mainPublished.headSha = mainSha;
  mainPublished.branch = "main";
  mainPublished.lastPollAt = NOW;
  expect(
    repos.cursors.put({
      repoId,
      streamId: MAIN_STREAM,
      kind: "published",
      cursor: mainPublished,
      expectedPrevious: null,
    }),
  ).toBe(true);

  const prDiscovery = emptyCursor("pull_request");
  prDiscovery.updatedAt = NOW;
  prDiscovery.page = null;
  prDiscovery.lastPollAt = NOW;
  expect(
    repos.cursors.put({
      repoId,
      streamId: PR_STREAM,
      kind: "discovery",
      cursor: prDiscovery,
      expectedPrevious: null,
    }),
  ).toBe(true);

  // Secrets live only in the excluded files; the archive scan must stay clean.
  fs.writeFileSync(
    paths.credentials,
    JSON.stringify({ kind: "token", token: CANARY, login: null }),
    { mode: 0o600 },
  );
  fs.writeFileSync(paths.session, JSON.stringify({ token: CANARY }), {
    mode: 0o600,
  });

  db.close();
  openDbs.splice(openDbs.indexOf(db), 1);

  return {
    dataDir,
    backupDir,
    restoredDir,
    repoId,
    projectId,
    mainSha,
    prSha,
    mainGenerationId,
    prGenerationId,
    mainLessonId,
    prLessonId,
    mainEventId,
    prEventId,
  };
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
}

afterAll(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gate-c dual-stream state × backup/restore/gc", () => {
  test("both stream generations, events and cursors survive backup and restore", async () => {
    const seeded = await seed();

    const backup = runScript(BACKUP_SCRIPT, [
      "--out",
      seeded.backupDir,
      "--data-dir",
      seeded.dataDir,
      "--json",
    ]);
    expect(backup.status, backup.stderr).toBe(0);
    const backupJson = JSON.parse(backup.stdout.trim()) as {
      files: { path: string }[];
      bundles: { repoId: string }[];
    };
    const archived = backupJson.files.map((file) => file.path);
    expect(archived).toContain("db/codetrail.sqlite");
    expect(
      archived.some((file) =>
        file.startsWith(`knowledge/${seeded.mainGenerationId}/lessons/`),
      ),
    ).toBe(true);
    expect(
      archived.some((file) =>
        file.startsWith(`knowledge/${seeded.prGenerationId}/lessons/`),
      ),
    ).toBe(true);
    expect(archived).toContain(`git-objects/${seeded.repoId}.bundle`);
    expect(archived).not.toContain("credentials.json");
    expect(archived).not.toContain("session.json");
    expect(archived.some((file) => file.startsWith("logs/"))).toBe(false);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(seeded.backupDir, "manifest.json"), "utf8"),
    ) as { sourceRoot: string; files: { path: string }[] };
    expect(manifest.sourceRoot).toBe(
      resolveDataPaths({ ...process.env, CODETRAIL_DATA_DIR: seeded.dataDir })
        .root,
    );
    expect(
      fs
        .readFileSync(path.join(seeded.backupDir, "db", "codetrail.sqlite"))
        .includes(CANARY),
      "the archived database carries no token",
    ).toBe(false);

    const restore = runScript(RESTORE_SCRIPT, [
      "--from",
      seeded.backupDir,
      "--data-dir",
      seeded.restoredDir,
      "--json",
    ]);
    expect(restore.status, restore.stderr).toBe(0);
    const restoreJson = JSON.parse(restore.stdout.trim()) as {
      failures: unknown[];
      restored: { generations: number };
    };
    expect(restoreJson.failures).toEqual([]);
    expect(restoreJson.restored.generations).toBe(2);

    const restoredPaths = resolveDataPaths({
      ...process.env,
      CODETRAIL_DATA_DIR: seeded.restoredDir,
    });
    const db = openDatabase({
      file: restoredPaths.db,
      clock: createClock(NOW),
    });
    openDbs.push(db);
    const repos = createRepositories(db);

    // Both generations are intact and still distinct: the PR preview keeps
    // head=PR head and base=merge-base while main keeps head=main head.
    const main = repos.generations.byId(seeded.mainGenerationId);
    const pr = repos.generations.byId(seeded.prGenerationId);
    expect(main).not.toBeNull();
    expect(pr).not.toBeNull();
    expect(main).toMatchObject({
      commitSha: seeded.mainSha,
      comparisonBaseSha: null,
      status: "published",
    });
    expect(pr).toMatchObject({
      commitSha: seeded.prSha,
      comparisonBaseSha: seeded.mainSha,
      status: "published",
    });
    expect(main!.cacheKey).not.toBe(pr!.cacheKey);

    for (const generation of [main!, pr!]) {
      const relative = path.relative(restoredPaths.root, generation.contentDir);
      expect(
        relative === ".." || relative.startsWith(`..${path.sep}`),
        `contentDir points outside the restored root: ${generation.contentDir}`,
      ).toBe(false);
      expect(fs.existsSync(generation.contentDir)).toBe(true);
    }

    // Lessons still resolve through the repository layer and the sealed files
    // are byte-identical to what the source data directory held.
    expect(repos.lessons.listByGeneration(seeded.mainGenerationId)).toHaveLength(
      1,
    );
    expect(repos.lessons.listByGeneration(seeded.prGenerationId)).toHaveLength(
      1,
    );
    const sourceKnowledge = resolveDataPaths({
      ...process.env,
      CODETRAIL_DATA_DIR: seeded.dataDir,
    }).knowledge;
    expect(
      sha256File(
        path.join(main!.contentDir, "lessons", `${seeded.mainLessonId}.json`),
      ),
    ).toBe(
      sha256File(
        path.join(
          sourceKnowledge,
          seeded.mainGenerationId,
          "lessons",
          `${seeded.mainLessonId}.json`,
        ),
      ),
    );

    // Change events keep their identity, linkage and payload.
    const events = repos.changes.page(seeded.projectId, null, 10).items;
    expect(events).toHaveLength(2);
    const byId = new Map(events.map((event) => [event.eventId, event]));
    expect(byId.get(seeded.mainEventId)).toMatchObject({
      eventKey: "ek:two-stream:main",
      streamKind: "default_branch",
      headSha: seeded.mainSha,
      state: "published",
    });
    expect(byId.get(seeded.prEventId)).toMatchObject({
      eventKey: "ek:two-stream:pr",
      streamKind: "pull_request",
      headSha: seeded.prSha,
      baseSha: seeded.mainSha,
      mergeBaseSha: seeded.mainSha,
      state: "published",
      linkedEventId: seeded.mainEventId,
      linkRelation: "supplementary",
    });

    // Both streams' cursors survive independently.
    expect(
      repos.cursors.get(seeded.repoId, MAIN_STREAM, "discovery")?.headSha,
    ).toBe(seeded.mainSha);
    expect(
      repos.cursors.get(seeded.repoId, MAIN_STREAM, "published")?.headSha,
    ).toBe(seeded.mainSha);
    expect(
      repos.cursors.get(seeded.repoId, PR_STREAM, "discovery")?.updatedAt,
    ).toBe(NOW);

    // GC keeps both published stream trees and reclaims only the orphan.
    const orphan = path.join(restoredPaths.knowledge, "g_orphan_workspace");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "leftover.json"), "{}\n", "utf8");

    const gc = await runGc({ dataDir: seeded.restoredDir });
    expect(gc.keptPublished).toBe(2);
    expect(gc.removedKnowledge).toEqual(["g_orphan_workspace"]);
    expect(
      fs.existsSync(path.join(restoredPaths.knowledge, seeded.mainGenerationId)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(restoredPaths.knowledge, seeded.prGenerationId)),
    ).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  }, 180_000);
});
