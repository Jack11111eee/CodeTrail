import { createTopicsRepo } from "./topics.repo.js";
import type { Database, Repositories } from "../contracts/index.js";
import { createAttemptsRepo } from "./attempts.repo.js";
import { createChangesRepo } from "./changes.repo.js";
import { createConversationsRepo } from "./conversations.repo.js";
import { createCursorsRepo } from "./cursors.repo.js";
import { createGenerationsRepo } from "./generations.repo.js";
import { createJobsRepo } from "./jobs.repo.js";
import { createLessonsRepo } from "./lessons.repo.js";
import { createPreferencesRepo } from "./prefs.repo.js";
import { createProjectsRepo } from "./projects.repo.js";
import { createReposRepo } from "./repos.repo.js";
import { createSettingsRepo } from "./settings.repo.js";
import { createSnapshotsRepo } from "./snapshots.repo.js";
import { createSourcesRepo } from "./sources.repo.js";
import { createTermsRepo } from "./terms.repo.js";
import { createUsageRepo } from "./usage.repo.js";

export * from "./db.js";
export * from "./migrate.js";

export { createAttemptsRepo } from "./attempts.repo.js";
export { createChangesRepo } from "./changes.repo.js";
export { createConversationsRepo } from "./conversations.repo.js";
export { createCursorsRepo } from "./cursors.repo.js";
export { createGenerationsRepo } from "./generations.repo.js";
export { createJobsRepo } from "./jobs.repo.js";
export { createLessonsRepo } from "./lessons.repo.js";
export { createPreferencesRepo } from "./prefs.repo.js";
export { createProjectsRepo } from "./projects.repo.js";
export { createReposRepo } from "./repos.repo.js";
export { createSettingsRepo } from "./settings.repo.js";
export { createSnapshotsRepo } from "./snapshots.repo.js";
export { createSourcesRepo } from "./sources.repo.js";
export { createTermsRepo } from "./terms.repo.js";
export { createUsageRepo } from "./usage.repo.js";

/** The single injection point for the persistence layer (§3.13, §13.3). */
export function createRepositories(db: Database): Repositories {
  return {
    repos: createReposRepo(db),
    projects: createProjectsRepo(db),
    snapshots: createSnapshotsRepo(db),
    jobs: createJobsRepo(db),
    attempts: createAttemptsRepo(db),
    generations: createGenerationsRepo(db),
    lessons: createLessonsRepo(db),
    topics: createTopicsRepo(db),
    sources: createSourcesRepo(db),
    conversations: createConversationsRepo(db),
    cursors: createCursorsRepo(db),
    changes: createChangesRepo(db),
    usage: createUsageRepo(db),
    prefs: createPreferencesRepo(db),
    settings: createSettingsRepo(db),
    terms: createTermsRepo(db),
  };
}
