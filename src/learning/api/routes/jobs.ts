/**
 * Job status, display-only events, cancel and retry (architecture §7.1,
 * §14.1, §14.4, §3.8).
 *
 * The durable row is authoritative. `GET /api/jobs/:id` projects it to
 * `JobView`; `GET /api/jobs/:id/events` is an SSE *view* of the same state and
 * never mutates anything, so a reconnecting client re-reads the row and
 * restores exactly what happened (AC-API-12).
 *
 * Cancel and retry delegate to the `JobRunner`, which owns the state machine
 * and the single-writer invariant. An unknown job is `404 not_found`; a job
 * that cannot be retried surfaces the runner's `job_not_retryable` (409).
 */

import {
  LearningError,
  errorMessageFor,
  RETRYABLE_JOB_STATES,
} from "../../contracts/index.js";
import type {
  AppDeps,
  HandlerFactory,
  JobEvent,
  JobId,
  JobRecord,
  JobState,
  JobView,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
} from "../../contracts/index.js";

export const routes: readonly RouteDef[] = [
  {
    method: "GET",
    pattern: "/api/jobs/:id",
    auth: "session",
    handler: "jobs.get",
  },
  {
    method: "GET",
    pattern: "/api/jobs/:id/events",
    auth: "session",
    handler: "jobs.events",
  },
  {
    method: "POST",
    pattern: "/api/jobs/:id/cancel",
    auth: "session",
    handler: "jobs.cancel",
  },
  {
    method: "POST",
    pattern: "/api/jobs/:id/retry",
    auth: "session",
    handler: "jobs.retry",
  },
];

const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function notFound(jobId: JobId): LearningError {
  return new LearningError("not_found", errorMessageFor("not_found", "zh"), {
    jobId,
  });
}

/** Projects the persisted row; every field is a public DTO field. */
export function toJobView(job: JobRecord): JobView {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    attempt: job.attempt,
    streamId: job.streamId,
    projectId: job.projectId,
    progress: job.progress,
    errorCode: job.errorCode,
    errorDetail: job.errorDetail,
    outputGenerationId: job.outputGenerationId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    retryable: RETRYABLE_JOB_STATES.includes(job.state),
  };
}

async function requireJob(deps: AppDeps, jobId: JobId): Promise<JobRecord> {
  const job = await deps.jobRunner.get(jobId);
  if (job === null) throw notFound(jobId);
  return job;
}

const getJob: HandlerFactory = (deps) => async (req) => {
  const job = await requireJob(deps, req.params.id as JobId);
  return { kind: "json", status: 200, body: toJobView(job) };
};

const cancelJob: HandlerFactory = (deps) => async (req) => {
  const job = await deps.jobRunner.cancel(req.params.id as JobId);
  return { kind: "json", status: 200, body: toJobView(job) };
};

const retryJob: HandlerFactory = (deps) => async (req) => {
  const job = await deps.jobRunner.retry(req.params.id as JobId);
  return { kind: "json", status: 202, body: toJobView(job) };
};

/**
 * Subscribes before reading the row so no event can slip between the two, then
 * yields the durable state first. A terminal job ends immediately; otherwise
 * the generator ends on the terminal state or when the client disconnects.
 */
async function* jobEvents(
  deps: AppDeps,
  jobId: JobId,
  signal: AbortSignal,
): AsyncGenerator<JobEvent> {
  const queue: JobEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const unsubscribe = deps.jobRunner.subscribe(jobId, (event) => {
    queue.push(event);
    wake?.();
  });
  const onAbort = (): void => {
    closed = true;
    wake?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const initial = await deps.jobRunner.get(jobId);
    if (initial === null) throw notFound(jobId);

    yield {
      jobId,
      seq: 0,
      at: initial.createdAt,
      type: "state",
      state: initial.state,
      ...(initial.progress ? { progress: initial.progress } : {}),
    };
    if (TERMINAL_STATES.has(initial.state)) return;

    while (!closed && !signal.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      if (closed || signal.aborted) break;

      const event = queue.shift();
      if (event === undefined) continue;
      yield event;
      if (
        event.type === "state" &&
        event.state !== undefined &&
        TERMINAL_STATES.has(event.state)
      ) {
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

const streamEvents: HandlerFactory = (deps) => async (req) => {
  const jobId = req.params.id as JobId;
  // An unknown job is a JSON 404, not an SSE stream that never says anything.
  await requireJob(deps, jobId);
  return {
    kind: "sse",
    events: jobEvents(deps, jobId, req.signal),
  };
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "jobs.get": getJob,
  "jobs.events": streamEvents,
  "jobs.cancel": cancelJob,
  "jobs.retry": retryJob,
};

export const jobsRoutes: RouteModule = {
  id: "jobs",
  routes,
  handlers,
};
