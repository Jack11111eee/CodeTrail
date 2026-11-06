import { recoveryProjectForJob } from "./project-job.js";
import { modelGateFor } from "../../config/metered-model.js";
/* eslint-disable @typescript-eslint/require-await -- the JobRunner port is async by contract */
/**
 * Durable job state machine (architecture §7.1).
 *
 * The only correctness mechanism for "one writer per stream" is the partial
 * unique index `idx_jobs_stream_running`; this module never keeps an
 * application lock. It schedules jobs FIFO in-process, transitions them through
 * the documented state table and lets the pipeline publish.
 *
 * Cancellation is cooperative: a queued job becomes `cancelled` immediately
 * (zero model calls), a running job goes `running → cancelling`, its signal is
 * aborted and the writer loop's exit moves it to `cancelled`. Usage recorded for
 * calls that already completed is kept.
 *
 * Restart is `recoverInterrupted()`: every `running`/`cancelling` row becomes
 * `interrupted` with `error_code = "interrupted"` and keeps its `job_id`, so
 * `retry()` runs attempt 2 on the same job.
 */

import {
  ALLOWED_JOB_TRANSITIONS,
  computeCacheKey,
  computeConfigHash,
  computeDedupeKey,
  jobIdFromDedupeKey,
  LearningError,
  RETRYABLE_JOB_STATES,
} from "../../contracts/index.js";
import type {
  EnqueueJobInput,
  GenerationRecord,
  JobErrorCode,
  JobEvent,
  JobId,
  JobRecord,
  JobRunner,
  JobRunnerDeps,
  JobState,
  NewJob,
} from "../../contracts/index.js";
import { UPSTREAM_VERSION } from "../../config/defaults.js";
import { executeJob, JobAbortedError, type ModelGate } from "./pipeline.js";
import { recordJobEvent } from "./progress.js";

// Declared in contracts/ports.ts (§3.13); re-export only.
export type {
  EnqueueJobInput,
  JobRunner,
  UsageMeter,
} from "../../contracts/index.js";
export { createUsageMeter } from "./usage.js";
export { createModelGate } from "./pipeline.js";
export type { ModelGate } from "./pipeline.js";

const JOB_ERROR_CODES: ReadonlySet<string> = new Set([
  "interrupted",
  "cancelled",
  "superseded",
  "object_unavailable",
  "source_drift",
  "protected_write_blocked",
  "budget_exhausted",
  "rate_limited",
  "github_auth_failed",
  "model_not_configured",
  "external_source_unavailable",
  "internal_error",
]);

function jobErrorCodeOf(error: unknown): JobErrorCode {
  if (error instanceof LearningError && JOB_ERROR_CODES.has(error.code)) {
    return error.code as JobErrorCode;
  }
  return "internal_error";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown, column: string): boolean {
  const message = messageOf(error);
  return /UNIQUE constraint failed/iu.test(message) && message.includes(column);
}

/** The subset of a transition table a job may take from `from`. */
export function allowedTransitions(from: JobState): readonly JobState[] {
  return ALLOWED_JOB_TRANSITIONS[from];
}

/** True when `from → to` is one of the documented transitions. */
export function isAllowedJobTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_JOB_TRANSITIONS[from].includes(to);
}

/** Implements `JobRunner` (§7.1). */
export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const { db, repos, clock } = deps;
  void db;

  const pending: JobId[] = [];
  const aborts = new Map<JobId, AbortController>();
  const listeners = new Map<JobId, Set<(event: JobEvent) => void>>();
  const retryClaims = new Set<string>();
  const drainWaiters: (() => void)[] = [];
  const gate: ModelGate = modelGateFor(db);

  let running: JobId | null = null;
  let scheduled = false;

  const now = (): string => clock.now().toISOString();

  /**
   * The only legal way to change `jobs.state`. It re-reads the row, rejects a
   * transition the table does not allow and then performs the compare-and-set,
   * so an illegal request leaves the stored state untouched (AC-GEN-01).
   */
  function transitionJob(
    jobId: JobId,
    to: JobState,
    patch?: Partial<JobRecord>,
  ): boolean {
    const job = repos.jobs.byId(jobId);
    if (job === null) return false;
    if (!ALLOWED_JOB_TRANSITIONS[job.state].includes(to)) return false;
    return repos.jobs.transition(jobId, [job.state], to, patch);
  }

  function emit(
    jobId: JobId,
    event: Omit<JobEvent, "jobId" | "seq" | "at">,
  ): void {
    const full = recordJobEvent(repos, jobId, event, now());
    if (!full) return;
    for (const listener of listeners.get(jobId) ?? []) {
      try {
        listener(full);
      } catch {
        // A display subscriber must never fail a job.
      }
    }
  }

  function resolveDrain(): void {
    if (running !== null || pending.length > 0) return;
    for (const resolve of drainWaiters.splice(0)) resolve();
  }

  function schedule(): void {
    if (running !== null || scheduled || pending.length === 0) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      void pump();
    });
  }

  function loadQueued(): void {
    for (const job of repos.jobs.listByState(["queued"])) {
      if (job.jobId !== running && !pending.includes(job.jobId))
        pending.push(job.jobId);
    }
  }

  async function pump(): Promise<void> {
    while (running === null && pending.length > 0) {
      const jobId = pending.shift() as JobId;
      const job = repos.jobs.byId(jobId);
      if (job === null || job.state !== "queued") continue;
      await runJob(job);
    }
    resolveDrain();
  }

  async function runJob(job: JobRecord): Promise<void> {
    running = job.jobId;
    const startedAt = now();
    const attempt = job.attempt === 0 ? 1 : job.attempt;
    const started = transitionJob(job.jobId, "running", {
      startedAt,
      attempt,
      errorCode: null,
      errorDetail: null,
      finishedAt: null,
    });
    if (!started) {
      running = null;
      return;
    }
    repos.attempts.open(job.jobId, attempt, startedAt);
    emit(job.jobId, { type: "state", state: "running" });

    const controller = new AbortController();
    aborts.set(job.jobId, controller);
    const current = repos.jobs.byId(job.jobId);
    if (current === null) {
      aborts.delete(job.jobId);
      running = null;
      return;
    }

    try {
      const result = await executeJob({
        deps,
        job: current,
        signal: controller.signal,
        gate,
        onProgress: (progress) =>
          emit(job.jobId, { type: "progress", progress }),
      });
      const latest = repos.jobs.byId(job.jobId);
      if (latest !== null && latest.state === "completed") {
        // `publishAtomic` committed the job inside its transaction.
        emit(job.jobId, { type: "state", state: "completed" });
      } else {
        const finishedAt = now();
        const completed = transitionJob(job.jobId, "completed", {
          outputGenerationId: result.generationId,
          finishedAt,
          errorCode: null,
          errorDetail: null,
        });
        if (completed) {
          repos.attempts.close(
            job.jobId,
            attempt,
            "completed",
            finishedAt,
            null,
          );
          emit(job.jobId, { type: "state", state: "completed" });
        }
      }
    } catch (error) {
      const latest = repos.jobs.byId(job.jobId);
      const cancelled =
        error instanceof JobAbortedError || controller.signal.aborted;
      const finishedAt = now();
      if (cancelled) {
        // The signal may fire before `cancel()` moved the row to cancelling;
        // the documented path is running → cancelling → cancelled.
        if (latest?.state === "running") {
          transitionJob(job.jobId, "cancelling");
        }
        const done = transitionJob(job.jobId, "cancelled", {
          finishedAt,
          errorCode: "cancelled",
          errorDetail: null,
        });
        if (done) {
          repos.attempts.close(
            job.jobId,
            attempt,
            "cancelled",
            finishedAt,
            null,
          );
          emit(job.jobId, { type: "state", state: "cancelled" });
        }
      } else if (latest !== null && latest.state === "cancelling") {
        const done = transitionJob(job.jobId, "cancelled", {
          finishedAt,
          errorCode: "cancelled",
          errorDetail: messageOf(error),
        });
        if (done) {
          repos.attempts.close(
            job.jobId,
            attempt,
            "cancelled",
            finishedAt,
            null,
          );
          emit(job.jobId, { type: "state", state: "cancelled" });
        }
      } else if (latest !== null && latest.state !== "completed") {
        const failed = transitionJob(job.jobId, "failed", {
          finishedAt,
          errorCode: jobErrorCodeOf(error),
          errorDetail: messageOf(error),
        });
        if (failed) {
          repos.attempts.close(job.jobId, attempt, "failed", finishedAt, null);
          emit(job.jobId, { type: "state", state: "failed" });
        }
      }
    } finally {
      aborts.delete(job.jobId);
      if (job.streamId !== null) retryClaims.delete(job.streamId);
      running = null;
      schedule();
      resolveDrain();
    }
  }

  function busyStream(streamId: string): boolean {
    return repos.jobs
      .listByStream(streamId)
      .some((job) => job.state === "running" || job.state === "cancelling");
  }

  function cacheHitFor(input: EnqueueJobInput): GenerationRecord | null {
    const repo = repos.repos.byId(input.repoId);
    if (repo === null) return null;
    let targetCommitSha: string;
    let baseContextSha: string | null;
    let scopeHash: string;
    let config;
    if (input.payload.kind === "generation") {
      const payload = input.payload;
      targetCommitSha = payload.commitSha;
      baseContextSha = payload.baseContextSha;
      scopeHash = payload.scope.hash || input.scopeHash;
      config = payload.config;
    } else if (input.payload.kind === "comparison") {
      targetCommitSha = input.payload.headSha;
      baseContextSha = input.baseContextSha;
      scopeHash = input.payload.scope.hash || input.scopeHash;
      config = input.payload.config;
    } else {
      return null;
    }
    const cacheKey = computeCacheKey({
      kind: input.payload.kind === "comparison" ? "comparison" : "research",
      comparisonBaseSha: input.comparisonBaseSha,
      repoIdentity: repo.identity,
      targetCommitSha,
      baseContextSha,
      scopeHash,
      generationConfigHash: computeConfigHash(config),
      promptTemplateVersion: config.promptTemplateVersion,
      preferencesVersion: repos.prefs.version(),
      upstreamVersion: UPSTREAM_VERSION,
    });
    const record = repos.generations.byCacheKey(cacheKey);
    return record !== null && record.status === "published" ? record : null;
  }

  return {
    async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
      const dedupeKey = computeDedupeKey(input);
      const existing = repos.jobs.byDedupeKey(dedupeKey);
      if (existing !== null) {
        if (existing.state === "queued") {
          loadQueued();
          schedule();
        }
        return existing;
      }

      if (input.streamId !== null && busyStream(input.streamId)) {
        throw new LearningError("busy_stream", "该流已有正在运行的任务", {
          streamId: input.streamId,
        });
      }

      const hit = cacheHitFor(input);
      const jobId = jobIdFromDedupeKey(dedupeKey);
      const at = now();
      const job: NewJob = {
        jobId,
        dedupeKey,
        kind: input.kind,
        repoId: input.repoId,
        projectId: input.projectId,
        streamId: input.streamId,
        state: hit === null ? "queued" : "completed",
        payload: input.payload,
        attempt: 0,
        errorCode: null,
        errorDetail: null,
        progress: null,
        outputGenerationId: hit?.generationId ?? null,
        createdAt: at,
        startedAt: hit === null ? null : at,
        finishedAt: hit === null ? null : at,
      };

      try {
        repos.jobs.insert(job);
      } catch (error) {
        const raced = repos.jobs.byDedupeKey(dedupeKey);
        if (raced !== null) return raced;
        if (isUniqueViolation(error, "jobs.stream_id")) {
          throw new LearningError("busy_stream", "该流已有正在运行的任务", {
            streamId: input.streamId,
          });
        }
        throw error;
      }

      if (hit === null) {
        pending.push(jobId);
        emit(jobId, { type: "state", state: "queued" });
        schedule();
      } else {
        emit(jobId, {
          type: "progress",
          progress: {
            phase: "publishing",
            done: 1,
            total: 1,
            message: "命中已发布缓存，复用已有讲解",
            cacheHit: true,
          },
        });
        emit(jobId, { type: "state", state: "completed" });
      }
      return repos.jobs.byId(jobId) as JobRecord;
    },

    async get(jobId: JobId): Promise<JobRecord | null> {
      return repos.jobs.byId(jobId);
    },

    async cancel(jobId: JobId): Promise<JobRecord> {
      const job = repos.jobs.byId(jobId);
      if (job === null) {
        throw new LearningError("not_found", "任务不存在", { jobId });
      }
      if (job.state === "queued") {
        const index = pending.indexOf(jobId);
        if (index !== -1) pending.splice(index, 1);
        const cancelled = transitionJob(jobId, "cancelled", {
          finishedAt: now(),
          errorCode: "cancelled",
        });
        if (cancelled) {
          emit(jobId, { type: "state", state: "cancelled" });
          // A retried-but-never-run job must not keep the stream claimed.
          if (job.streamId !== null) retryClaims.delete(job.streamId);
        }
        resolveDrain();
        return repos.jobs.byId(jobId) as JobRecord;
      }
      if (job.state === "running") {
        const cancelling = transitionJob(jobId, "cancelling");
        if (cancelling) emit(jobId, { type: "state", state: "cancelling" });
        aborts.get(jobId)?.abort();
        return repos.jobs.byId(jobId) as JobRecord;
      }
      // `cancelling` is already on its way; terminal states are unchanged.
      return job;
    },

    async retry(jobId: JobId): Promise<JobRecord> {
      const job = repos.jobs.byId(jobId);
      if (job === null) {
        throw new LearningError("not_found", "任务不存在", { jobId });
      }
      if (job.streamId !== null && retryClaims.has(job.streamId)) {
        throw new LearningError("busy_stream", "该流已有正在运行的任务", {
          streamId: job.streamId,
        });
      }
      if (!RETRYABLE_JOB_STATES.includes(job.state)) {
        throw new LearningError("job_not_retryable", "该任务不可重试", {
          jobId,
          state: job.state,
        });
      }
      if (job.streamId !== null && busyStream(job.streamId)) {
        throw new LearningError("busy_stream", "该流已有正在运行的任务", {
          streamId: job.streamId,
        });
      }
      const owner = job.projectId ? repos.projects.byId(job.projectId) : null;
      const recoveredProject = owner?.deletedAt
        ? recoveryProjectForJob(repos, job)
        : null;
      if (owner?.deletedAt && !recoveredProject)
        throw new LearningError(
          "source_removed",
          "原项目已移除，未找到唯一且读取范围相同的恢复项目",
          { jobId },
        );
      if (job.streamId !== null) retryClaims.add(job.streamId);

      repos.jobs.bumpAttempt(jobId);
      const queued = transitionJob(jobId, "queued", {
        projectId: recoveredProject?.projectId ?? job.projectId,
        errorCode: null,
        errorDetail: null,
        startedAt: null,
        finishedAt: null,
        outputGenerationId: null,
      });
      if (!queued) {
        if (job.streamId !== null) retryClaims.delete(job.streamId);
        throw new LearningError("job_not_retryable", "该任务不可重试", {
          jobId,
          state: repos.jobs.byId(jobId)?.state ?? job.state,
        });
      }
      emit(jobId, { type: "state", state: "queued" });
      pending.push(jobId);
      schedule();
      return repos.jobs.byId(jobId) as JobRecord;
    },

    async recoverInterrupted(): Promise<number> {
      const rows = repos.jobs.listByState(["running", "cancelling"]);
      let recovered = 0;
      for (const job of rows) {
        const at = now();
        // Boot-time repair (§7.1), not a user transition: both running and
        // cancelling rows become interrupted so `retry()` can continue them.
        const interrupted = repos.jobs.transition(
          job.jobId,
          ["running", "cancelling"],
          "interrupted",
          { errorCode: "interrupted", finishedAt: at, errorDetail: null },
        );
        if (!interrupted) continue;
        emit(job.jobId, { type: "state", state: "interrupted" });
        const attempt = repos.attempts
          .list(job.jobId)
          .find((entry) => entry.state === "running");
        if (attempt !== undefined) {
          repos.attempts.close(
            job.jobId,
            attempt.attempt,
            "interrupted",
            at,
            null,
          );
        }
        recovered += 1;
      }
      loadQueued();
      schedule();
      return recovered;
    },

    wake(): void {
      loadQueued();
      schedule();
    },

    drain(): Promise<void> {
      loadQueued();
      schedule();
      if (running === null && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },

    subscribe(jobId: JobId, callback: (event: JobEvent) => void): () => void {
      let bucket = listeners.get(jobId);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(jobId, bucket);
      }
      bucket.add(callback);
      return () => {
        bucket?.delete(callback);
      };
    },
  };
}
