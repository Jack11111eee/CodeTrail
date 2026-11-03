/**
 * Watch scheduler (architecture §12.5).
 *
 * One tick is a pure function of the injected clock and discovery service, so
 * tests drive ticks directly with `runWatchTick` and never sleep. Disabling
 * watch stops discovery but never deletes records; local projects are rejected
 * with `watch_requires_github`.
 */

import {
  DEFAULT_WATCH_INTERVAL_MS,
  DISCOVERY_DEFAULTS,
  PR_OVERLAP_MS,
} from "../config/defaults.js";
import { LearningError } from "../contracts/index.js";
import type {
  ProjectId,
  WatchDeps,
  WatchScheduler,
  WatchTickResult,
} from "../contracts/index.js";
import { DEFAULT_BRANCH_STREAM, reconcileEventStates } from "./discovery.js";

// Declared in contracts/ports.ts (§3.13); re-export only.
export type { WatchScheduler, WatchTickResult, WatchDeps };

/** The canonical entry point (`runWatchTick(projectId)` in PRD §15.2.3). */
export async function runWatchTick(
  deps: WatchDeps,
  projectId: ProjectId,
): Promise<WatchTickResult> {
  const project = deps.repos.projects.byId(projectId);
  if (project === null || project.deletedAt !== null) {
    throw new LearningError("not_found", "项目不存在", { projectId });
  }
  if (project.kind !== "github") {
    throw new LearningError(
      "watch_requires_github",
      "只有 GitHub 项目可以开启跟进",
      { projectId },
    );
  }
  if (!project.watchEnabled) {
    throw new LearningError("conflict", "跟进未开启", { projectId });
  }

  reconcileEventStates(deps.repos, projectId);

  const opts = {
    now: deps.clock.now(),
    overlapMs: PR_OVERLAP_MS,
    perPage: DISCOVERY_DEFAULTS.perPage,
    maxPages: DISCOVERY_DEFAULTS.maxPages,
  };
  const defaultBranch = await deps.discovery.tickDefaultBranch(projectId, opts);
  const pullRequests = await deps.discovery.tickPullRequests(projectId, opts);

  const cursor = deps.repos.cursors.get(
    project.repoId,
    DEFAULT_BRANCH_STREAM,
    "discovery",
  );
  return {
    projectId,
    discovered: defaultBranch.discovered + pullRequests.discovered,
    enqueued: defaultBranch.enqueued + pullRequests.enqueued,
    gaps: defaultBranch.gaps + pullRequests.gaps,
    lastPollAt: cursor?.lastPollAt ?? deps.clock.now().toISOString(),
  };
}

/** Alias kept for test readability (`runTick(projectId)`). */
export const runTick = runWatchTick;

/**
 * Implements `WatchScheduler` (§3.13). `intervalMs` defaults to five minutes
 * (AC-UPD-03); `runTick()` without a project ticks every watched GitHub
 * project, and one project's failure never stops the others.
 */
export function createWatchScheduler(deps: WatchDeps): WatchScheduler {
  const intervalMs =
    Number.isFinite(deps.intervalMs) && deps.intervalMs > 0
      ? deps.intervalMs
      : DEFAULT_WATCH_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void this.runTick().catch(() => undefined);
      }, intervalMs);
      // A background interval must not keep a test process alive.
      const handle = timer as unknown as { unref?: () => void };
      handle.unref?.();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },

    async runTick(projectId?: ProjectId): Promise<WatchTickResult[]> {
      if (projectId !== undefined) {
        return [await runWatchTick(deps, projectId)];
      }
      const results: WatchTickResult[] = [];
      for (const project of deps.repos.projects.list()) {
        if (!project.watchEnabled || project.kind !== "github") continue;
        try {
          results.push(await runWatchTick(deps, project.projectId));
        } catch {
          // A single failing project must not stop the scheduler.
        }
      }
      return results;
    },

    lastPollAt(projectId: ProjectId): string | null {
      const project = deps.repos.projects.byId(projectId);
      if (project === null) return null;
      const cursor = deps.repos.cursors.get(
        project.repoId,
        DEFAULT_BRANCH_STREAM,
        "discovery",
      );
      return cursor?.lastPollAt ?? null;
    },
  };
}
