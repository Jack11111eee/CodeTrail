export type JobKind =
  "generation_initial" | "generation_update" | "change_analysis" | "comparison";

export type JobState =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type JobAttemptState =
  "running" | "completed" | "failed" | "cancelled" | "interrupted";

export const ALLOWED_JOB_TRANSITIONS: Readonly<
  Record<JobState, readonly JobState[]>
> = {
  queued: ["running", "cancelling", "cancelled"],
  running: ["completed", "failed", "cancelling", "interrupted"],
  cancelling: ["cancelled"],
  completed: [], // only reachable again through retry() which is rejected
  failed: ["queued"], // retry()
  cancelled: ["queued"], // retry()
  interrupted: ["queued"], // retry()
};

export const RETRYABLE_JOB_STATES: readonly JobState[] = [
  "failed",
  "cancelled",
  "interrupted",
];

export interface JobProgress {
  phase:
    | "queued"
    | "resolving"
    | "snapshot"
    | "planning"
    | "pages"
    | "lessons"
    | "checking"
    | "sealing"
    | "publishing"
    | "diffing"
    | "analyzing";
  done: number;
  total: number | null;
  message?: string;
  /** Durable, bounded display history; never raw model output or tool input. */
  activities?: JobActivity[];
  seq?: number;
  updatedAt?: string;
  commitSha?: string;
  pages?: {
    done: number;
    total: number | null;
    current?: string;
    processed?: number;
    skipped?: number;
  };
  pageFailures?: { page: string; code: string; message: string }[];
  cacheHit?: boolean;
  /** The job has committed a reusable build checkpoint. */
  resumeAvailable?: boolean;
}

export interface JobActivity {
  seq: number;
  at: string;
  attempt: number;
  phase: JobProgress["phase"];
  message: string;
}
