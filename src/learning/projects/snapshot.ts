/**
 * The snapshot service (architecture §5.7).
 *
 * `SnapshotService` is the only read surface bound to
 * `(repo_id, commit_sha, tree_hash)`: resolution turns any ref into a full SHA,
 * `ensure` reuses or creates the immutable worktree and records it in
 * `snapshots`, and reads always go through a `SnapshotReader` built for that
 * exact commit.
 */

import { mirrorPath } from "../config/paths.js";
import { LearningError } from "../contracts/index.js";
import type {
  Clock,
  CoverageReport,
  DataPaths,
  GenerationId,
  NormalizedScope,
  RepoId,
  Repositories,
  SnapshotRecord,
  SnapshotService,
} from "../contracts/index.js";
import { buildCoverageReport } from "./coverage.js";
import { ensureObjectAvailable, mirrorExists } from "./mirror.js";
import type { MirrorHandle } from "./mirror.js";
import {
  createSnapshotReader,
  ensureWorktree,
  listTreeEntries,
  resolveRef,
  worktreeMatches,
} from "./worktree.js";

// Declared in contracts (§3.11, §3.13, §3.10); re-export only.
export type { SnapshotRecord, SnapshotService, CoverageReport };

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function createSnapshotService(deps: {
  paths: DataPaths;
  repos: Repositories;
  clock: Clock;
}): SnapshotService {
  const { paths, repos, clock } = deps;

  function handleFor(repoId: RepoId): MirrorHandle {
    const record = repos.repos.byId(repoId);
    if (record === null) {
      throw new LearningError("not_found", "仓库不存在", { repoId });
    }
    return {
      repoId,
      path: record.mirrorPath || mirrorPath(paths, repoId),
      identity: record.identity,
    };
  }

  return {
    async resolve(repoId: RepoId, ref: string): Promise<string> {
      const handle = handleFor(repoId);
      if (!(await mirrorExists(paths, repoId))) {
        throw new LearningError("object_unavailable", "镜像不存在", { repoId });
      }
      return resolveRef(handle, ref);
    },

    async ensure(repoId: RepoId, sha: string): Promise<SnapshotRecord> {
      const commitSha = sha.trim().toLowerCase();
      if (!SHA_PATTERN.test(commitSha)) {
        throw new LearningError("invalid_input", "需要完整的提交 SHA", {
          field: "commitSha",
          value: sha,
        });
      }

      const existing = repos.snapshots.byCommit(repoId, commitSha);
      if (existing !== null) {
        if (await worktreeMatches(paths, repoId, commitSha)) {
          return existing;
        }
      }

      const handle = handleFor(repoId);
      const availability = await ensureObjectAvailable(handle, commitSha);
      if (availability === "missing") {
        throw new LearningError("object_unavailable", "提交对象不可用", {
          repoId,
          commitSha,
        });
      }

      const worktree = await ensureWorktree(paths, handle, commitSha);
      const record: SnapshotRecord = {
        repoId,
        commitSha,
        treeHash: worktree.treeHash,
        worktreePath: worktree.path,
        resolvedAt: clock.now().toISOString(),
      };
      repos.snapshots.upsert(record);
      return record;
    },

    async readFile(
      snap: SnapshotRecord,
      relPath: string,
      scope: NormalizedScope,
    ): Promise<string> {
      return createSnapshotReader(snap, scope).read(relPath);
    },

    async listFiles(
      snap: SnapshotRecord,
      scope: NormalizedScope,
    ): Promise<{ path: string; bytes: number }[]> {
      return createSnapshotReader(snap, scope).list(scope);
    },

    async coverage(
      snap: SnapshotRecord,
      scope: NormalizedScope,
      generationId: GenerationId,
    ): Promise<CoverageReport> {
      const entries = await listTreeEntries(snap.worktreePath, snap.commitSha);
      const reader = createSnapshotReader(snap, scope);
      return buildCoverageReport({
        generationId,
        commitSha: snap.commitSha,
        scope,
        entries,
        // The reader applies `assertReadable`; the report only ever inspects
        // the first bytes (LFS pointer header / `.gitmodules` declarations).
        readBlob: async (relPath: string) =>
          (await reader.read(relPath)).slice(0, 512),
      });
    },
  };
}
