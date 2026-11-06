import { computeScopeHash } from "../../contracts/index.js";
import type {
  JobRecord,
  JobState,
  ProjectRecord,
  Repositories,
} from "../../contracts/index.js";

const STATES: JobState[] = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/** A re-import may recover unpublished work from its removed predecessor. */
export function recoveryProjectForJob(
  repos: Repositories,
  job: JobRecord,
): ProjectRecord | null {
  if (
    job.payload.kind !== "generation" ||
    !job.progress?.resumeAvailable ||
    !job.projectId ||
    !repos.projects.byId(job.projectId)?.deletedAt
  )
    return null;
  const scopeHash = computeScopeHash(job.payload.scope);
  const matches = repos.projects
    .list()
    .filter(
      (project) =>
        project.repoId === job.repoId &&
        computeScopeHash(project.scope) === scopeHash,
    );
  // Multiple active imports are ambiguous; never pick one by list order.
  return matches.length === 1 ? matches[0] : null;
}

export function latestProjectJob(
  repos: Repositories,
  project: ProjectRecord,
): JobRecord | null {
  const own = repos.jobs.listByProject(project.projectId, STATES).at(-1);
  if (own) return own;
  return (
    repos.jobs
      .listByState(STATES)
      .filter(
        (job) =>
          ["failed", "cancelled", "interrupted"].includes(job.state) &&
          job.repoId === project.repoId &&
          recoveryProjectForJob(repos, job)?.projectId === project.projectId,
      )
      .at(-1) ?? null
  );
}
