/**
 * Shared doubles for the evidence tests: an isolated data directory + database,
 * a `SourceRegistry` over the real repositories, and an in-memory
 * `SnapshotReader`.
 */

import type {
  Clock,
  DataPaths,
  Database,
  GenerationId,
  GenerationRecord,
  RepoId,
  Repositories,
  SnapshotReader,
} from "../../../src/learning/contracts/index.js";
import { LearningError } from "../../../src/learning/contracts/index.js";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.js";
import {
  createSourceRegistry,
  type SourceRegistryInternals,
} from "../../../src/learning/evidence/registry.js";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.js";
import { normalizeScope } from "../../../src/learning/projects/scope.js";

export const AT = "2026-01-01T00:00:00.000Z";
export const HEAD_SHA = "a".repeat(40);
export const BASE_SHA = "b".repeat(40);

export function fixedClock(iso = AT): Clock {
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

export interface EvidenceHarness {
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: Clock;
  registry: SourceRegistryInternals;
  close(): void;
}

/** One isolated data dir (set by the learning setup guard) and a migrated DB. */
export async function createEvidenceHarness(): Promise<EvidenceHarness> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);
  const clock = fixedClock();
  const db = openDatabase({ file: paths.db, clock });
  migrate(db);
  const repos = createRepositories(db);
  return {
    paths,
    db,
    repos,
    clock,
    registry: createSourceRegistry({
      clock,
      sources: repos.sources,
      generations: repos.generations,
    }),
    close() {
      db.close();
    },
  };
}

/** A published generation row with the fields the registry reads. */
export function makeGeneration(
  overrides: Partial<GenerationRecord> = {},
): GenerationRecord {
  const generationId = (overrides.generationId ?? "g_1") as GenerationId;
  return {
    generationId,
    cacheKey: `ck_${generationId}`,
    repoId: "r_1" as RepoId,
    projectId: null,
    commitSha: HEAD_SHA,
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: "sc_1",
    configHash: "cf_1",
    promptTemplateVersion: "codetrail-lesson-v1",
    preferencesVersion: 0,
    upstreamVersion: "0.7.2+7bb583d664f2",
    status: "published",
    contentDir: `/tmp/knowledge/${generationId}`,
    sealedTreeHash: "tree-1",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: AT,
    publishedAt: AT,
    ...overrides,
  };
}

export interface FakeSnapshotOptions {
  commitSha?: string;
  repoId?: string;
}

/** In-memory `SnapshotReader`; no Git, no filesystem, no scope surprises. */
export function fakeSnapshot(
  files: Record<string, string>,
  options: FakeSnapshotOptions = {},
): SnapshotReader {
  const commitSha = options.commitSha ?? HEAD_SHA;
  const repoId = (options.repoId ?? "r_1") as RepoId;

  const textOf = (relPath: string): string => {
    const text = files[relPath];
    if (text === undefined) {
      throw new LearningError("not_found", "文件不存在", { path: relPath });
    }
    return text;
  };

  return {
    repoId,
    commitSha,
    treeHash: `tree-${commitSha.slice(0, 8)}`,
    read: (relPath) => Promise.resolve(textOf(relPath)),
    exists: (relPath) => Promise.resolve(relPath in files),
    slice: (relPath, lines) => {
      const all = textOf(relPath).split(/\r?\n/u);
      const start = Math.max(1, Math.trunc(lines.start));
      const end = Math.max(start, Math.trunc(lines.end));
      return Promise.resolve(all.slice(start - 1, end).join("\n"));
    },
    list: () =>
      Promise.resolve(
        Object.entries(files).map(([relPath, text]) => ({
          path: relPath,
          bytes: Buffer.byteLength(text, "utf8"),
        })),
      ),
  };
}

export const DEFAULT_SCOPE = normalizeScope();
