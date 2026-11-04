/**
 * Operational views: usage accounting and the read-only storage report
 * (architecture §3.8, §3.11, §14.1, §5.8, AC-OPS-09).
 *
 * `GET /api/usage` groups `usage_records` by task kind through
 * `UsageRepo.groupByKind`. When no price is configured every cost is `null`;
 * the totals are derived from the returned groups so they can never disagree.
 *
 * `GET /api/storage` is a pure directory walk. It opens nothing for write,
 * follows no symlink and counts every file under the data root — including the
 * bytes of removed projects, because nothing here is project-scoped and the
 * user must be able to see what is still on disk. `totalBytes` therefore
 * matches an independent walk of the root.
 */

import fs from "node:fs";
import path from "node:path";

import { mirrorPath } from "../../config/paths.js";
import type {
  ConversationId,
  DataPaths,
  GenerationId,
  HandlerFactory,
  ProjectId,
  RepoId,
  Repositories,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
  StorageView,
  UsageKind,
  UsageView,
} from "../../contracts/index.js";

export const routes: RouteDef[] = [
  {
    method: "GET",
    pattern: "/api/usage",
    auth: "session",
    handler: "usage.get",
  },
  {
    method: "GET",
    pattern: "/api/storage",
    auth: "session",
    handler: "storage.get",
  },
];

/** Display order used by the settings page and by the tests. */
const USAGE_KINDS: readonly UsageKind[] = Object.freeze([
  "initial",
  "update",
  "comparison",
  "qa",
  "change",
]);

// ── usage ───────────────────────────────────────────────────────────────────

function summarize(
  groups: UsageView["groups"],
  pricingConfigured: boolean,
): UsageView {
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let costSum = 0;
  let costsSeen = false;
  for (const group of groups) {
    inputTokens += group.inputTokens;
    outputTokens += group.outputTokens;
    calls += group.calls;
    if (group.costCents !== null) {
      costSum += group.costCents;
      costsSeen = true;
    }
  }
  return {
    groups,
    totals: {
      inputTokens,
      outputTokens,
      calls,
      costCents: pricingConfigured && costsSeen ? costSum : null,
      pricingConfigured,
    },
  };
}

/** Exported for the settings page and for direct unit assertions. */
export function toUsageView(
  groups: UsageView["groups"],
  pricingConfigured: boolean,
): UsageView {
  const order = new Map<UsageKind, number>(
    USAGE_KINDS.map((kind, index) => [kind, index]),
  );
  const sorted = [...groups]
    .map((group) => ({
      ...group,
      // An unpriced deployment never reports an amount, even if a legacy row
      // still carries a number.
      costCents: pricingConfigured ? group.costCents : null,
    }))
    .sort(
      (a, b) =>
        (order.get(a.kind) ?? USAGE_KINDS.length) -
        (order.get(b.kind) ?? USAGE_KINDS.length),
    );
  return summarize(sorted, pricingConfigured);
}

const getUsage: HandlerFactory = (deps) => (req) => {
  const rawKind = req.query.kind;
  const kind =
    rawKind === undefined || rawKind === ""
      ? undefined
      : (rawKind as UsageKind);
  const pricingConfigured = deps.repos.settings.model()?.pricing != null;
  const groups = deps.repos.usage.groupByKind(kind);
  return Promise.resolve({
    kind: "json",
    status: 200,
    body: toUsageView(groups, pricingConfigured),
  });
};

// ── storage ─────────────────────────────────────────────────────────────────

/** Recursive size of every regular file under `dir`; 0 when it does not exist. */
function directoryBytes(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Symlinks are neither followed nor counted: the walk stays inside the
    // data directory and cannot double-count a linked tree.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += directoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.lstatSync(full).size;
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total;
}

function childDirectoryBytes(dir: string): { name: string; bytes: number }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; bytes: number }[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    out.push({
      name: entry.name,
      bytes: directoryBytes(path.join(dir, entry.name)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function addBytes<K>(map: Map<K, number>, key: K, bytes: number): void {
  map.set(key, (map.get(key) ?? 0) + bytes);
}

/**
 * Builds the storage report from the filesystem and the repositories.
 *
 * - `totalBytes`: every regular file under `paths.root`.
 * - `byGeneration`: each `knowledge/<generationId>/` tree.
 * - `bySnapshot`: each `work/<repoId>/<commitSha>/` tree.
 * - `byProject`: mirrors + worktrees + generation content attributable to a
 *   project. Removed projects are discovered through their generations, so
 *   their bytes stay visible after removal.
 * - `byConversation`: per-conversation artifact trees under
 *   `external/conversations/<conversationId>/`. Conversation messages live in
 *   SQLite and are covered by `totalBytes`; no per-conversation directory is
 *   created until an artifact is exported there.
 */
export function computeStorageReport(
  paths: DataPaths,
  repos: Repositories,
): StorageView {
  const generations = childDirectoryBytes(paths.knowledge);
  const byGeneration = generations.map((entry) => ({
    generationId: entry.name as GenerationId,
    bytes: entry.bytes,
  }));

  const bySnapshot: StorageView["bySnapshot"] = [];
  for (const repo of childDirectoryBytes(paths.work)) {
    for (const snapshot of childDirectoryBytes(
      path.join(paths.work, repo.name),
    )) {
      bySnapshot.push({
        repoId: repo.name as RepoId,
        commitSha: snapshot.name,
        bytes: snapshot.bytes,
      });
    }
  }

  const projectBytes = new Map<ProjectId, number>();
  const repoProjects = new Map<RepoId, Set<ProjectId>>();

  const attributeRepo = (repoId: RepoId, projectId: ProjectId): void => {
    const set = repoProjects.get(repoId) ?? new Set<ProjectId>();
    set.add(projectId);
    repoProjects.set(repoId, set);
    if (!projectBytes.has(projectId)) projectBytes.set(projectId, 0);
  };

  for (const project of repos.projects.list()) {
    attributeRepo(project.repoId, project.projectId);
  }

  for (const entry of generations) {
    const record = repos.generations.byId(entry.name as GenerationId);
    if (record === null || record.projectId === null) continue;
    attributeRepo(record.repoId, record.projectId);
    addBytes(projectBytes, record.projectId, entry.bytes);
  }

  for (const [repoId, projectIds] of repoProjects) {
    const repoBytes =
      directoryBytes(mirrorPath(paths, repoId)) +
      directoryBytes(path.join(paths.work, repoId));
    for (const projectId of projectIds) {
      addBytes(projectBytes, projectId, repoBytes);
    }
  }

  const byProject = [...projectBytes.entries()]
    .map(([projectId, bytes]) => ({ projectId, bytes }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));

  const byConversation = childDirectoryBytes(
    path.join(paths.external, "conversations"),
  ).map((entry) => ({
    conversationId: entry.name as ConversationId,
    bytes: entry.bytes,
  }));

  return {
    totalBytes: directoryBytes(paths.root),
    byProject,
    byGeneration,
    bySnapshot,
    byConversation,
  };
}

const getStorage: HandlerFactory = (deps) => () =>
  Promise.resolve({
    kind: "json",
    status: 200,
    body: computeStorageReport(deps.paths, deps.repos),
  });

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "usage.get": getUsage,
  "storage.get": getStorage,
};

export const opsModule: RouteModule = {
  id: "ops",
  routes,
  handlers,
};
