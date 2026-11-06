import type {
  JobEvent,
  JobId,
  JobProgress,
  Repositories,
  UpstreamRunEvent,
} from "../../contracts/index.js";

type DisplayEvent = Omit<JobEvent, "jobId" | "seq" | "at">;
const STATE_MESSAGES: Record<string, string> = {
  queued: "任务已排队，等待开始",
  running: "开始分析",
  cancelling: "正在取消，等待当前操作结束",
  completed: "分析完成，讲解已发布",
  failed: "分析失败，可查看错误并重试",
  cancelled: "任务已取消",
  interrupted: "服务已重启，任务中断，可重试",
};
const HISTORY_LIMIT = 100;

/** Commit before notifying subscribers, so refresh and live views agree. */
export function recordJobEvent(
  repos: Repositories,
  jobId: JobId,
  event: DisplayEvent,
  at: string,
): JobEvent | null {
  const job = repos.jobs.byId(jobId);
  if (!job) return null;
  const previous = job.progress;
  let progress: JobProgress = {
    phase: "queued",
    done: 0,
    total: null,
    ...previous,
  };
  if (event.type === "state" && event.state === "queued") {
    progress = previous
      ? { ...previous, message: "任务已排队，将从已保存的断点继续" }
      : { phase: "queued", done: 0, total: null };
  } else if (event.progress) {
    progress = { ...progress, ...event.progress };
  }
  const seq = (previous?.seq ?? 0) + 1;
  const message = (
    event.message ??
    (event.type === "state"
      ? STATE_MESSAGES[event.state ?? ""]
      : event.progress?.message) ??
    "任务状态已更新"
  ).slice(0, 300);
  const activities = [...(previous?.activities ?? [])];
  const last = activities.at(-1);
  if (
    !last ||
    last.message !== message ||
    last.attempt !== job.attempt ||
    last.phase !== progress.phase
  ) {
    activities.push({
      seq,
      at,
      attempt: job.attempt,
      phase: progress.phase,
      message,
    });
  }
  progress = {
    ...progress,
    message,
    seq,
    updatedAt: at,
    activities: activities.slice(-HISTORY_LIMIT),
  };
  repos.jobs.updateProgress(jobId, progress);
  return { jobId, seq, at, ...event, progress };
}

/** Translates observable actions only; free text/debug events are excluded. */
export function upstreamProgress(
  event: UpstreamRunEvent,
  current: JobProgress,
): JobProgress | null {
  if (event.type === "repository_progress") {
    const planning = event.stage === "planning" || event.stage === "replanning";
    const total = event.pageCount ?? current.pages?.total ?? null;
    // Sequential runs report a one-based pageIndex; concurrent runs report completedCount.
    const completed =
      event.completedCount ??
      (event.successfulCount !== undefined && event.skippedCount !== undefined
        ? event.successfulCount + event.skippedCount
        : undefined) ??
      (event.stage === "finalizing"
        ? (total ?? current.pages?.done ?? 0)
        : (event.pageIndex ?? 0) > 0
          ? (event.pageIndex ?? 1) - 1
          : (current.pages?.done ?? 0));
    const pages = {
      done: Math.max(0, event.successfulCount ?? completed),
      ...(event.skippedCount === undefined
        ? {}
        : { skipped: event.skippedCount, processed: Math.max(0, completed) }),
      total,
      ...(event.page ? { current: event.page } : {}),
    };
    if (planning)
      return {
        phase: "planning",
        done: 0,
        total: null,
        message:
          event.message ??
          (event.stage === "replanning"
            ? "正在调整文档规划"
            : "正在探索项目并规划文档"),
        pages: { done: 0, total: null },
      };
    return {
      phase: "pages",
      done: pages.done,
      total: pages.total,
      pages,
      ...(event.failure && event.page
        ? {
            pageFailures: [
              ...(current.pageFailures ?? []).filter(
                (failure) => failure.page !== event.page,
              ),
              { page: event.page, ...event.failure },
            ].slice(-100),
          }
        : event.stage === "finalizing" && event.skippedCount === 0
          ? { pageFailures: [] }
          : {}),
      message:
        event.message ??
        (event.stage === "noop"
          ? "项目文档无需更新，复用已有内容"
          : event.stage === "finalizing"
            ? "正在整理项目文档与来源"
            : event.page
              ? `正在生成文档：${event.page}`
              : "正在生成项目文档"),
    };
  }
  const actions: Record<string, string> = {
    read_file: "读取文件",
    ls: "浏览目录",
    glob: "查找文件",
    grep: "搜索代码",
    write_file: "编写文档",
    edit_file: "更新文档",
    submit_plan: "提交文档规划",
    submit_page: "提交文档",
    inspect_claims: "检查代码证据",
  };
  const action = actions[event.name ?? ""];
  if (!action || event.type !== "tool_start") return null;
  return {
    phase: current.phase,
    done: current.done,
    total: current.total,
    message: `${action}${event.path ? `：${event.path}` : event.page ? `：${event.page}` : ""}`,
  };
}
