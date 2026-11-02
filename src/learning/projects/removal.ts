/**
 * Project removal and dependents (architecture §5.8, AC-PRJ-14).
 *
 * Removal is a soft delete. Without `confirm` nothing is written at all; with
 * it, exactly two columns change (`deleted_at`, `watch_enabled = 0`) in one
 * transaction. Every artifact row and every `knowledge/**` directory survives,
 * so old links keep existing (and therefore return `410`, never `404`) and a
 * removed project can never redirect to a newer generation.
 */

import { LearningError } from "../contracts/index.js";
import type {
  ChangeEventId,
  Clock,
  ConversationId,
  Database,
  GenerationId,
  JobRunner,
  LessonId,
  ProjectDependents,
  ProjectId,
  ProjectState,
  RemovalService,
  Repositories,
} from "../contracts/index.js";

// Declared in contracts/ports.ts (§5.8); re-export only.
export type { ProjectState, ProjectDependents, RemovalService };
export { assertProjectActive } from "../contracts/index.js";

interface IdRow {
  id: string;
}

export function createRemovalService(deps: {
  db: Database;
  repos: Repositories;
  clock: Clock;
  /** Optional canceller; queued/running jobs are cancelled after the write. */
  jobs?: Pick<JobRunner, "cancel">;
}): RemovalService {
  const { db, repos, clock } = deps;

  // `ConversationsRepo` and `ChangesRepo` expose `countByProject` only. Rather
  // than widening a frozen contract, the two id-list queries live here as
  // narrow read-only SQL (sprint guidance for issue-08).
  const conversationsStmt = db.raw.prepare(
    `SELECT DISTINCT c.conversation_id AS id
     FROM conversations c
     JOIN json_each(c.generation_ids_json) AS j
     JOIN generations g ON g.generation_id = j.value
     WHERE g.project_id = ?
     ORDER BY c.conversation_id ASC`,
  );
  const changeEventsStmt = db.raw.prepare(
    `SELECT event_id AS id FROM change_events
     WHERE project_id = ?
     ORDER BY discovered_at ASC, event_id ASC`,
  );

  function stateOf(projectId: ProjectId): ProjectState {
    const project = repos.projects.byId(projectId);
    if (project === null) return "unknown";
    return project.deletedAt === null ? "active" : "removed";
  }

  function collect(projectId: ProjectId): ProjectDependents {
    const generations: GenerationId[] = repos.generations
      .listByProject(projectId)
      .map((generation) => generation.generationId)
      // `listByProject` is newest-first for the API; dependents are a set, so
      // expose a stable id order.
      .sort((left, right) => left.localeCompare(right));

    const lessons = new Set<LessonId>();
    for (const generationId of generations) {
      for (const lesson of repos.lessons.listByGeneration(generationId)) {
        lessons.add(lesson.lessonId);
      }
    }

    const conversations = (conversationsStmt.all(projectId) as IdRow[]).map(
      (row) => row.id as ConversationId,
    );

    const changeEvents = (changeEventsStmt.all(projectId) as IdRow[]).map(
      (row) => row.id as ChangeEventId,
    );

    return {
      conversations,
      lessons: [...lessons].sort((left, right) => left.localeCompare(right)),
      generations,
      changeEvents,
    };
  }

  function requireExisting(projectId: ProjectId): void {
    if (stateOf(projectId) === "unknown") {
      throw new LearningError("not_found", "项目不存在", { projectId });
    }
  }

  return {
    dependents(projectId: ProjectId): Promise<ProjectDependents> {
      return Promise.resolve().then(() => {
        requireExisting(projectId);
        return collect(projectId);
      });
    },

    async remove(
      projectId: ProjectId,
      confirm: boolean,
    ): Promise<ProjectDependents> {
      const state = stateOf(projectId);
      if (state === "unknown") {
        throw new LearningError("not_found", "项目不存在", { projectId });
      }
      if (state === "removed") {
        throw new LearningError("source_removed", "项目已被移除", {
          reason: "project_removed",
          projectId,
        });
      }
      if (!confirm) {
        throw new LearningError("invalid_input", "移除项目需要确认", {
          reason: "confirm_required",
          projectId,
        });
      }

      const dependents = collect(projectId);
      const now = clock.now().toISOString();
      db.transaction(() => {
        repos.projects.markDeleted(projectId, now);
        // `scope === null` keeps the stored scope; only watch_enabled flips.
        repos.projects.setWatch(projectId, false, null);
      });

      if (deps.jobs !== undefined) {
        const jobs = repos.jobs.listByProject(projectId, ["queued", "running"]);
        for (const job of jobs) {
          await deps.jobs.cancel(job.jobId);
        }
      }

      return dependents;
    },

    state(projectId: ProjectId): ProjectState {
      return stateOf(projectId);
    },
  };
}
