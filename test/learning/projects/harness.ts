import fs from "node:fs";
import path from "node:path";

import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import {
  LearningError,
  newProjectId,
  normalizeScope,
  type Clock,
  type DataPaths,
  type Database,
  type ProjectRecord,
  type RepoId,
  type RepoIdentity,
  type RepoRecord,
  type Repositories,
} from "../../../src/learning/contracts/index.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import {
  cloneMirror,
  type MirrorHandle,
} from "../../../src/learning/projects/mirror.ts";
import { localIdentity } from "../../../src/learning/projects/identity.ts";
import { fixturePath, fixtureSha } from "../helpers/git-fixture.ts";

/** Deterministic clock; every service under test receives it explicitly. */
export function fixedClock(iso = "2026-01-01T00:00:00.000Z"): Clock {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set(value: string) {
      current = new Date(value);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export interface ProjectsHarness {
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: Clock;
  close(): void;
}

/**
 * One isolated data directory (installed by the learning setup guard) with the
 * migrated database and repositories inside it.
 */
export async function createHarness(): Promise<ProjectsHarness> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);
  const clock = fixedClock();
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  return {
    paths,
    db,
    repos: createRepositories(db),
    clock,
    close() {
      db.close();
    },
  };
}

export function seedRepo(
  harness: ProjectsHarness,
  overrides: Partial<RepoRecord> & { identity: RepoIdentity },
): RepoRecord {
  const record: RepoRecord = {
    repoId: overrides.repoId ?? ("r_1" as RepoId),
    identity: overrides.identity,
    kind: overrides.kind ?? "local",
    mirrorPath: overrides.mirrorPath ?? "/tmp/mirror.git",
    remoteUrl: overrides.remoteUrl ?? null,
    createdAt: overrides.createdAt ?? harness.clock.now().toISOString(),
  };
  return harness.repos.repos.upsert(record);
}

export function seedProject(
  harness: ProjectsHarness,
  overrides: Partial<ProjectRecord> & { repoId: RepoId },
): ProjectRecord {
  const record: ProjectRecord = {
    projectId: overrides.projectId ?? newProjectId(),
    repoId: overrides.repoId,
    kind: overrides.kind ?? "local",
    displayName: overrides.displayName ?? "Example",
    remoteUrl: overrides.remoteUrl ?? null,
    defaultBranch: overrides.defaultBranch ?? "main",
    scope: overrides.scope ?? normalizeScope(),
    watchEnabled: overrides.watchEnabled ?? false,
    createdAt: overrides.createdAt ?? harness.clock.now().toISOString(),
    deletedAt: overrides.deletedAt ?? null,
  };
  harness.repos.projects.insert(record);
  return record;
}

export interface ClonedFixture {
  identity: RepoIdentity;
  handle: MirrorHandle;
  repo: RepoRecord;
  sourcePath: string;
  sha: string;
}

/** Clones a fixture repository into the harness mirror directory. */
export async function cloneFixture(
  harness: ProjectsHarness,
  name: string,
  options: { repoId?: RepoId } = {},
): Promise<ClonedFixture> {
  const sourcePath = fixturePath(name);
  const identity = localIdentity(sourcePath);
  const handle = await cloneMirror(harness.paths, identity, {
    localPath: sourcePath,
  });
  const repo = seedRepo(harness, {
    identity,
    repoId: options.repoId ?? handle.repoId,
    kind: "local",
    mirrorPath: handle.path,
  });
  return {
    identity,
    handle,
    repo,
    sourcePath,
    sha: fixtureSha(name, "HEAD"),
  };
}

/** Restores owner write bits so a read-only snapshot tree can be deleted. */
export function restoreWritable(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      restoreWritable(child);
      try {
        fs.chmodSync(child, 0o755);
      } catch {
        // best effort
      }
    } else {
      try {
        fs.chmodSync(child, 0o644);
      } catch {
        // best effort
      }
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // best effort
  }
}

/** Runs `fn`, asserting it threw a `LearningError`, and returns it typed. */
export function thrownBy(fn: () => unknown): LearningError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LearningError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a LearningError to be thrown");
}
