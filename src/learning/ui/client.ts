/** Same-origin progressive enhancement. Untrusted content is rendered as text. */
interface JsonResult {
  ok: boolean;
  body: unknown;
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null
    ? (value as JsonObject)
    : {};
}
function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}
function errorText(body: unknown, fallback = "操作失败，请稍后重试。"): string {
  const error = object(object(body).error);
  return typeof error.message === "string" ? error.message : fallback;
}
async function requestJson(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<JsonResult> {
  try {
    const response = await fetch(url, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      /* An empty response is valid. */
    }
    return { ok: response.ok, body: parsed };
  } catch {
    return {
      ok: false,
      body: {
        error: { message: "网络连接失败，请检查本地服务是否仍在运行。" },
      },
    };
  }
}
function setStatus(
  container: HTMLElement,
  message: string,
  state: "neutral" | "success" | "error" = "neutral",
): void {
  let status = container.querySelector<HTMLElement>("[data-form-status]");
  if (!status) {
    status = document.createElement("p");
    status.dataset.formStatus = "true";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    container.append(status);
  }
  status.textContent = message;
  status.dataset.status = state;
}
function valueOf(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}
const submitting = new WeakSet<HTMLFormElement>();
function onSubmit(form: HTMLFormElement, action: () => Promise<void>): void {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting.has(form)) return;
    submitting.add(form);
    const buttons = Array.from(form.elements).filter(
      (el): el is HTMLButtonElement =>
        el instanceof HTMLButtonElement &&
        (el.type === "submit" || el.hasAttribute("data-model-test")),
    );
    const disabled = buttons.map((button) => button.disabled);
    buttons.forEach((button) => {
      button.disabled = true;
    });
    void action()
      .catch(() => setStatus(form, "操作失败，请重试。"))
      .finally(() => {
        submitting.delete(form);
        buttons.forEach((button, index) => {
          button.disabled = disabled[index];
        });
      });
  });
}
function wireDialogs(): void {
  document
    .querySelectorAll<HTMLElement>("[data-open-dialog]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const dialog = document.getElementById(
          button.dataset.openDialog ?? "",
        ) as HTMLDialogElement | null;
        if (dialog && !dialog.open) dialog.showModal();
      }),
    );
  document
    .querySelectorAll<HTMLElement>("[data-close-dialog]")
    .forEach((button) =>
      button.addEventListener("click", () => button.closest("dialog")?.close()),
    );
  document
    .querySelectorAll<HTMLElement>("[data-import-kind]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        document
          .querySelectorAll<HTMLElement>("[data-import-kind]")
          .forEach((item) =>
            item.setAttribute("aria-pressed", String(item === button)),
          );
        document
          .querySelectorAll<HTMLElement>("[data-project-kind]")
          .forEach((form) => {
            form.hidden =
              form.dataset.projectKind !== button.dataset.importKind;
          });
      }),
    );
}
function wireLessonManagement(): void {
  const form = document.querySelector<HTMLFormElement>("[data-delete-lesson]");
  if (form)
    onSubmit(form, async () => {
      const generation = form.dataset.generationId ?? "";
      const lesson = form.dataset.lessonId ?? "";
      const result = await requestJson(
        `/api/generations/${encodeURIComponent(generation)}/lessons/${encodeURIComponent(lesson)}?confirm=true`,
        "DELETE",
      );
      if (!result.ok) {
        setStatus(form, errorText(result.body), "error");
        return;
      }
      const grid = document.querySelector<HTMLElement>(".reader-grid");
      if (grid) grid.dataset.lessonId = "";
      const url = new URL("/learn/reader", window.location.origin);
      url.searchParams.set("generation", generation);
      const next = object(result.body).nextLessonId;
      if (typeof next === "string" && next)
        url.searchParams.set("lesson", next);
      window.location.assign(url.href);
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-restore-lesson]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        if (button.disabled) return;
        button.disabled = true;
        const generation = button.dataset.generationId ?? "";
        const lesson = button.dataset.restoreLesson ?? "";
        void requestJson(
          `/api/generations/${encodeURIComponent(generation)}/lessons/${encodeURIComponent(lesson)}/restore`,
          "POST",
          {},
        )
          .then((result) => {
            if (!result.ok) {
              setStatus(
                button.closest<HTMLElement>(".deleted-lessons") ?? button,
                errorText(result.body),
                "error",
              );
              return;
            }
            window.location.assign(
              `/learn/reader?generation=${encodeURIComponent(generation)}&lesson=${encodeURIComponent(lesson)}`,
            );
          })
          .finally(() => {
            button.disabled = false;
          });
      }),
    );
}

function topicUrl(generation: string, topic?: string): string {
  return `/learn/reader?generation=${encodeURIComponent(generation)}${topic ? `&topic=${encodeURIComponent(topic)}` : ""}`;
}

function wireTopics(): void {
  const create = document.querySelector<HTMLFormElement>("[data-create-topic]");
  if (create)
    onSubmit(create, async () => {
      const result = await requestJson(
        `/api/generations/${encodeURIComponent(create.dataset.generationId ?? "")}/topics`,
        "POST",
        { title: valueOf(create, "title") },
      );
      const topic = object(result.body);
      if (!result.ok || typeof topic.topicId !== "string") {
        setStatus(create, errorText(result.body, "无法创建主题。"), "error");
        return;
      }
      window.location.assign(
        topicUrl(create.dataset.generationId ?? "", topic.topicId),
      );
    });
  const remove = document.querySelector<HTMLFormElement>("[data-delete-topic]");
  if (remove)
    onSubmit(remove, async () => {
      const result = await requestJson(
        `/api/topics/${encodeURIComponent(remove.dataset.topicId ?? "")}?confirm=true`,
        "DELETE",
      );
      if (!result.ok) {
        setStatus(remove, errorText(result.body), "error");
        return;
      }
      window.location.assign(topicUrl(remove.dataset.generationId ?? ""));
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-restore-topic]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        if (button.disabled) return;
        button.disabled = true;
        void requestJson(
          `/api/topics/${encodeURIComponent(button.dataset.restoreTopic ?? "")}/restore`,
          "POST",
          {},
        )
          .then((result) => {
            if (!result.ok) {
              setStatus(
                button.closest<HTMLElement>(".deleted-topics") ?? button,
                errorText(result.body),
                "error",
              );
              return;
            }
            window.location.assign(
              topicUrl(
                button.dataset.generationId ?? "",
                button.dataset.restoreTopic,
              ),
            );
          })
          .catch(() =>
            setStatus(
              button.closest<HTMLElement>(".deleted-topics") ?? button,
              "恢复失败，请重试。",
              "error",
            ),
          )
          .finally(() => {
            button.disabled = false;
          });
      }),
    );
  const article = document.querySelector<HTMLElement>("[data-active-topic]");
  if (!article) return;
  const id = article.dataset.activeTopic ?? "";
  let polling: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const poll = async () => {
    if (closed) return;
    try {
      const result = await requestJson(`/api/topics/${encodeURIComponent(id)}`);
      if (result.ok && object(result.body).state !== "generating") {
        window.location.reload();
        return;
      }
    } catch {
      /* Retry a transient status fetch. */
    }
    if (!closed)
      polling = setTimeout(() => {
        void poll();
      }, 2000);
  };
  if (article.dataset.topicState === "generating")
    polling = setTimeout(() => {
      void poll();
    }, 2000);
  const form = article.querySelector<HTMLFormElement>("[data-topic-question]");
  let active: AbortController | null = null;
  window.addEventListener(
    "pagehide",
    () => {
      closed = true;
      clearTimeout(polling);
      active?.abort();
    },
    { once: true },
  );
  if (!form) return;
  const input = form.querySelector<HTMLTextAreaElement>("[name='text']");
  const stop = form.querySelector<HTMLButtonElement>("[data-topic-stop]");
  stop?.addEventListener("click", () => active?.abort());
  onSubmit(form, async () => {
    const text = input?.value.trim() ?? "";
    if (!text) {
      setStatus(form, "请先输入问题。");
      return;
    }
    active = new AbortController();
    if (stop) stop.hidden = false;
    const preview = article.querySelector<HTMLElement>(
      "[data-topic-draft-preview]",
    );
    if (preview) preview.textContent = "";
    let content = "",
      ended = false,
      complete = false,
      reason = "";
    setStatus(form, "正在检索项目证据并生成讲解…");
    try {
      const response = await fetch(
        `/api/topics/${encodeURIComponent(id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: active.signal,
        },
      );
      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          /* Generic error below. */
        }
        throw new Error(errorText(body));
      }
      await consumeSse(response, (event) => {
        if (event.type === "delta" && typeof event.text === "string") {
          content += event.text;
          if (preview) preview.textContent = content;
        }
        if (event.type === "tool_call")
          setStatus(form, "正在查阅项目文档和代码依据…");
        if (event.type === "error") {
          reason =
            typeof event.message === "string"
              ? event.message
              : errorText(event);
          setStatus(form, reason, "error");
        }
        if (event.type === "done") {
          ended = true;
          complete = event.status === "complete";
        }
      });
      if (complete) {
        setStatus(form, "讲解已保存，正在打开…");
        window.location.reload();
      } else
        setStatus(
          form,
          reason ||
            (ended
              ? "本次未生成完整讲解，问题已保留，可以重试。"
              : "连接中断，问题已保留，可以重试。"),
          "error",
        );
    } catch (error) {
      setStatus(
        form,
        active.signal.aborted
          ? "已停止生成，问题已保留，可以重试。"
          : error instanceof Error
            ? error.message
            : "生成失败，可以重试。",
        "error",
      );
    } finally {
      active = null;
      if (stop) stop.hidden = true;
    }
  });
}

function wireProjectForms(): void {
  document
    .querySelectorAll<HTMLFormElement>("form[data-project-kind]")
    .forEach((form) =>
      onSubmit(form, async () => {
        const ref = valueOf(form, "ref");
        const payload: JsonObject =
          form.dataset.projectKind === "local"
            ? { localPath: valueOf(form, "localPath") }
            : {
                githubUrl: valueOf(form, "githubUrl"),
                ...(ref ? { ref } : {}),
              };
        setStatus(form, "正在导入独立代码快照…");
        const result = await requestJson("/api/projects", "POST", payload);
        if (!result.ok) {
          setStatus(
            form,
            errorText(result.body, "添加失败，请检查路径或 URL。"),
          );
          return;
        }
        const projectId = object(result.body).projectId;
        if (typeof projectId !== "string") {
          setStatus(form, "导入响应无效。");
          return;
        }
        saveLocal(`codetrail:ref:${projectId}`, ref || "HEAD");
        if (form.dataset.modelConfigured !== "true") {
          window.location.assign(
            `/settings?project=${encodeURIComponent(projectId)}`,
          );
          return;
        }
        setStatus(form, "项目已添加，正在提交分析…");
        const analysis = await requestJson(
          `/api/projects/${encodeURIComponent(projectId)}/analyses`,
          "POST",
          { ref: ref || "HEAD" },
        );
        // Keep the imported project even if the analysis cannot be submitted.
        if (!analysis.ok) {
          setStatus(form, `项目已添加。${errorText(analysis.body)}`);
          const link = document.createElement("a");
          link.href = `/?project=${encodeURIComponent(projectId)}`;
          link.textContent = "返回项目继续";
          form.append(link);
          return;
        }
        const jobId = textOf(object(analysis.body).jobId);
        window.location.assign(
          `/?project=${encodeURIComponent(projectId)}${jobId ? `&job=${encodeURIComponent(jobId)}` : ""}`,
        );
      }),
    );
  document
    .querySelectorAll<HTMLFormElement>("[data-analysis-form]")
    .forEach((form) => {
      const pinned = readLocal(`codetrail:ref:${form.dataset.projectId ?? ""}`);
      const refField = form.querySelector<HTMLInputElement>("[name='ref']");
      if (pinned && refField) refField.value = pinned;
      onSubmit(form, async () => {
        const projectId = form.dataset.projectId ?? "";
        const include = valueOf(form, "include")
          .split(/[,，\n]/u)
          .map((path) => path.trim())
          .filter(Boolean);
        saveLocal(`codetrail:ref:${projectId}`, valueOf(form, "ref") || "HEAD");
        setStatus(form, "正在准备分析…");
        const result = await requestJson(
          `/api/projects/${encodeURIComponent(projectId)}/analyses`,
          "POST",
          {
            ref: valueOf(form, "ref") || "HEAD",
            ...(include.length ? { scope: { include } } : {}),
          },
        );
        if (!result.ok) {
          setStatus(form, errorText(result.body));
          return;
        }
        const jobId = object(result.body).jobId;
        const card = form
          .closest<HTMLElement>("[data-project-id]")
          ?.closest<HTMLElement>(".project-card");
        const panel = card?.querySelector<HTMLElement>("[data-project-job]");
        if (panel && typeof jobId === "string") {
          panel.dataset.jobId = jobId;
          panel.dataset.jobState = "queued";
          openJobPanel(panel);
        }
        setStatus(form, "分析已提交，可在项目中查看进度。");
      });
    });
}
const terminalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const stateLabels: Record<string, string> = {
  queued: "排队中",
  running: "正在分析",
  cancelling: "正在取消",
  completed: "已完成",
  failed: "分析失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const phaseLabels: Record<string, string> = {
  queued: "等待开始",
  resolving: "准备代码快照",
  snapshot: "准备代码快照",
  planning: "探索项目与规划文档",
  pages: "生成项目文档",
  lessons: "生成阅读讲解",
  checking: "校验内容与证据",
  sealing: "保存并发布",
  publishing: "保存并发布",
  diffing: "分析代码差异",
  analyzing: "分析代码差异",
};
const jobViews = new Map<string, JsonObject>();
const refreshingJobs = new WeakSet<HTMLElement>();
const actingJobs = new WeakSet<HTMLElement>();
let jobSource: EventSource | null = null;
let sourceJobId = "";
function progressDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("#analysis-progress");
}
function boardText(root: HTMLElement, selector: string, value: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (el) el.textContent = value;
}
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}
function updateJobClock(): void {
  const dialog = progressDialog();
  const job = dialog?.open
    ? jobViews.get(dialog.dataset.jobId ?? "")
    : undefined;
  if (!dialog || !job) return;
  const progress = object(job.progress);
  const end =
    typeof job.finishedAt === "string"
      ? Date.parse(job.finishedAt)
      : Date.now();
  const start =
    typeof job.startedAt === "string"
      ? Date.parse(job.startedAt)
      : Date.parse(textOf(progress.updatedAt, textOf(job.createdAt)));
  boardText(
    dialog,
    "[data-board-elapsed]",
    Number.isFinite(start)
      ? `${job.state === "queued" ? "已排队" : "耗时"} ${duration(end - start)}`
      : "",
  );
  const updated = Date.parse(textOf(progress.updatedAt));
  boardText(
    dialog,
    "[data-board-updated]",
    Number.isFinite(updated)
      ? terminalStates.has(textOf(job.state))
        ? `最后活动 ${new Date(updated).toLocaleTimeString()}`
        : `最近活动 ${duration(Date.now() - updated)}前`
      : "",
  );
}
function renderJobBoard(job: JsonObject, panel: HTMLElement): void {
  const dialog = progressDialog();
  const id = panel.dataset.jobId ?? "";
  if (!dialog?.open || dialog.dataset.jobId !== id) return;
  const state = textOf(job.state);
  const progress = object(job.progress);
  const phase = textOf(progress.phase);
  const title =
    panel.closest(".project-card")?.querySelector("h2")?.textContent ??
    "项目分析";
  boardText(dialog, "[data-board-title]", title);
  boardText(dialog, "[data-board-state]", stateLabels[state] ?? "读取中");
  const badge = dialog.querySelector<HTMLElement>("[data-board-state]");
  if (badge) badge.dataset.state = state;
  boardText(
    dialog,
    "[data-board-attempt]",
    `第 ${Math.max(1, Number(job.attempt) || 1)} 次尝试`,
  );
  boardText(
    dialog,
    "[data-board-meta]",
    `${typeof progress.commitSha === "string" ? `提交 ${progress.commitSha.slice(0, 12)} · ` : ""}任务 ${id.slice(0, 18)}`,
  );
  boardText(
    dialog,
    "[data-board-current]",
    textOf(
      progress.message,
      state === "completed"
        ? "任务已完成，可开始学习。"
        : state === "queued"
          ? "任务已排队，等待开始。"
          : "此任务尚无阶段记录，正在等待进度更新。",
    ),
  );
  const research =
    job.kind === "generation_initial" || job.kind === "generation_update";
  const steps = research
    ? ["snapshot", "planning", "pages", "lessons", "checking", "publishing"]
    : ["snapshot", "diffing", "lessons", "checking", "publishing"];
  const canonical =
    phase === "resolving"
      ? "snapshot"
      : phase === "sealing"
        ? "publishing"
        : phase === "analyzing"
          ? "diffing"
          : phase;
  const index = steps.indexOf(canonical);
  const list = dialog.querySelector<HTMLOListElement>("[data-board-steps]");
  const stepKey = `${state}:${phase}:${progress.cacheHit === true}`;
  if (list && dialog.dataset.stepKey !== stepKey) {
    dialog.dataset.stepKey = stepKey;
    list.replaceChildren();
    if (progress.cacheHit === true) {
      const item = document.createElement("li");
      item.dataset.stepState = "done";
      item.textContent = "✓ 已复用已发布结果，无需重复分析";
      list.append(item);
    } else if (!phase && terminalStates.has(state)) {
      const item = document.createElement("li");
      item.textContent = "此历史任务没有保存阶段记录。";
      list.append(item);
    } else
      steps.forEach((step, position) => {
        const item = document.createElement("li");
        const done = state === "completed" || (index >= 0 && position < index);
        const active = !done && position === index;
        const error =
          active && ["failed", "cancelled", "interrupted"].includes(state);
        item.dataset.stepState = done
          ? "done"
          : error
            ? "stopped"
            : active
              ? "active"
              : "pending";
        if (active) item.setAttribute("aria-current", "step");
        const indicator = document.createElement("span");
        indicator.className = "job-step-indicator";
        indicator.setAttribute("aria-hidden", "true");
        indicator.textContent = done ? "✓" : error ? "!" : String(position + 1);
        const label = document.createElement("span");
        label.textContent = phaseLabels[step];
        const status = document.createElement("small");
        status.textContent = done
          ? "完成"
          : error
            ? stateLabels[state]
            : active
              ? state === "cancelling"
                ? "正在取消"
                : "进行中"
              : "待开始";
        item.append(indicator, label, status);
        list.append(item);
      });
  }
  const pages = object(progress.pages);
  const pagePanel = dialog.querySelector<HTMLElement>("[data-board-pages]");
  if (pagePanel)
    pagePanel.hidden =
      typeof pages.total !== "number" && typeof pages.current !== "string";
  const total =
    typeof pages.total === "number" ? Math.max(0, pages.total) : null;
  const done = Math.max(0, Number(pages.done) || 0);
  boardText(
    dialog,
    "[data-board-count]",
    (total === null ? `已完成 ${done} 篇` : `已完成 ${done} / ${total} 篇`) +
      (Number(pages.skipped) > 0
        ? ` · 待重试 ${Number(pages.skipped)} 篇`
        : ""),
  );
  boardText(
    dialog,
    "[data-board-page]",
    typeof pages.current === "string" && !terminalStates.has(state)
      ? `当前章节：${pages.current}`
      : "",
  );
  const bar = dialog.querySelector<HTMLProgressElement>(
    "[data-board-page-progress]",
  );
  if (bar) {
    bar.hidden = total === null || total <= 0;
    bar.max = total || 1;
    bar.value = Math.max(done, Number(pages.processed) || 0);
  }
  const error = dialog.querySelector<HTMLElement>("[data-board-error]");
  if (error) {
    error.hidden = !["failed", "interrupted"].includes(state);
    error.textContent =
      state === "interrupted"
        ? "服务重启后任务已中断。已保存的活动仍可查看，可以重试本次分析。"
        : textOf(job.errorDetail, "分析失败，请检查模型配置或配额后重试。");
    const failures = Array.isArray(progress.pageFailures)
      ? progress.pageFailures.map(object)
      : [];
    if (failures.length && state === "failed")
      error.textContent += `\n待处理页面：${failures.map((failure) => `${textOf(failure.page)}：${textOf(failure.message)}`).join("；")}`;
  }
  const activities: unknown[] = Array.isArray(progress.activities)
    ? (progress.activities as unknown[])
    : [];
  const activityKey = `${id}:${textOf(progress.seq)}:${activities.length}`;
  const timeline = dialog.querySelector<HTMLOListElement>(
    "[data-board-activities]",
  );
  if (timeline && dialog.dataset.activityKey !== activityKey) {
    dialog.dataset.activityKey = activityKey;
    timeline.replaceChildren();
    if (!activities.length) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = "暂无活动记录。任务开始后会自动更新。";
      timeline.append(item);
    }
    for (const raw of [...activities].reverse()) {
      const activity = object(raw),
        item = document.createElement("li"),
        time = document.createElement("time"),
        message = document.createElement("span");
      time.dateTime = textOf(activity.at);
      const date = new Date(time.dateTime);
      time.textContent = Number.isFinite(date.getTime())
        ? date.toLocaleTimeString()
        : "—";
      message.textContent = `${Number(activity.attempt) > 1 ? `[第 ${Number(activity.attempt)} 次] ` : ""}${textOf(activity.message)}`;
      item.append(time, message);
      timeline.append(item);
    }
  }
  const cancel = dialog.querySelector<HTMLButtonElement>(
    "[data-board-job-action='cancel']",
  );
  if (cancel) {
    cancel.hidden = terminalStates.has(state);
    cancel.disabled = state === "cancelling" || actingJobs.has(panel);
  }
  const retry = dialog.querySelector<HTMLButtonElement>(
    "[data-board-job-action='retry']",
  );
  if (retry) {
    retry.hidden = job.retryable !== true;
    retry.disabled = actingJobs.has(panel);
    retry.textContent =
      progress.resumeAvailable === true ? "从断点继续" : "重试分析";
  }
  const result = dialog.querySelector<HTMLAnchorElement>("[data-board-result]");
  if (result) {
    result.hidden = state !== "completed" || !job.outputGenerationId;
    if (!result.hidden)
      result.href = `/learn/reader?generation=${encodeURIComponent(textOf(job.outputGenerationId))}`;
  }
  if (terminalStates.has(state)) {
    jobSource?.close();
    jobSource = null;
    boardText(
      dialog,
      "[data-board-connection]",
      progress.resumeAvailable === true && state !== "completed"
        ? "断点和已生成文件已保存在本机，可从断点继续。"
        : "任务已结束，记录已保存在本机。",
    );
  }
  updateJobClock();
}
async function refreshJob(panel: HTMLElement): Promise<void> {
  const id = panel.dataset.jobId;
  if (!id || refreshingJobs.has(panel)) return;
  refreshingJobs.add(panel);
  try {
    const result = await requestJson(`/api/jobs/${encodeURIComponent(id)}`);
    if (panel.dataset.jobId !== id) return;
    if (!result.ok) {
      const detail = panel.querySelector("[data-job-detail]");
      if (detail) detail.textContent = "暂时无法获取任务状态，正在重试…";
      const dialog = progressDialog();
      if (dialog?.dataset.jobId === id)
        boardText(
          dialog,
          "[data-board-connection]",
          `${errorText(result.body)} 正在重试获取任务状态。`,
        );
      return;
    }
    const job = object(result.body),
      state = textOf(job.state),
      progress = object(job.progress);
    jobViews.set(id, job);
    panel.dataset.jobState = state;
    boardText(panel, "[data-job-status]", stateLabels[state] ?? state);
    const pages = object(progress.pages);
    boardText(
      panel,
      "[data-job-detail]",
      typeof job.errorDetail === "string"
        ? job.errorDetail
        : `${textOf(progress.message)}${typeof pages.total === "number" ? ` · 文档 ${Number(pages.done) || 0}/${pages.total}` : ""}`,
    );
    const cancel = panel.querySelector<HTMLButtonElement>(
      "[data-job-action='cancel']",
    );
    if (cancel) {
      cancel.hidden = terminalStates.has(state);
      cancel.disabled = state === "cancelling" || actingJobs.has(panel);
    }
    const retry = panel.querySelector<HTMLButtonElement>(
      "[data-job-action='retry']",
    );
    if (retry) {
      retry.hidden = job.retryable !== true;
      retry.disabled = actingJobs.has(panel);
      retry.textContent =
        progress.resumeAvailable === true ? "从断点继续" : "重试分析";
    }
    const primaryJobButton = panel
      .closest(".project-card")
      ?.querySelector<HTMLButtonElement>(".project-actions button.primary");
    if (primaryJobButton && job.retryable === true) {
      primaryJobButton.type = "button";
      primaryJobButton.removeAttribute("form");
      primaryJobButton.dataset.primaryJobAction = "retry";
      primaryJobButton.textContent =
        progress.resumeAvailable === true ? "从断点继续" : "重试分析";
      primaryJobButton.disabled = actingJobs.has(panel);
    } else if (
      primaryJobButton &&
      ["queued", "running", "cancelling"].includes(state)
    ) {
      primaryJobButton.disabled = true;
      primaryJobButton.textContent = "正在分析";
    }
    const open = panel.querySelector<HTMLButtonElement>("[data-open-job]");
    if (open) open.hidden = false;
    const card = panel.closest(".project-card");
    if (job.outputGenerationId && state === "completed" && card) {
      const actions = card.querySelector(".project-actions");
      if (
        actions &&
        !Array.from(actions.querySelectorAll("a")).some(
          (link) =>
            link.getAttribute("href") ===
            `/learn/reader?generation=${encodeURIComponent(textOf(job.outputGenerationId))}`,
        )
      ) {
        const link = document.createElement("a");
        link.className = "button primary";
        link.href = `/learn/reader?generation=${encodeURIComponent(textOf(job.outputGenerationId))}`;
        link.textContent = "开始学习 →";
        const primary = actions.querySelector(".primary");
        if (primary) primary.replaceWith(link);
        else actions.prepend(link);
      }
    }
    // A completed task can be analyzed again; a running one cannot be submitted twice.
    card
      ?.querySelectorAll<HTMLButtonElement>(
        "[data-analysis-form] button[type='submit'], .project-actions button[type='submit']",
      )
      .forEach((button) => {
        button.disabled = !terminalStates.has(state);
      });
    const primaryButton = card?.querySelector<HTMLButtonElement>(
      ".project-actions button[type='submit']",
    );
    if (primaryButton)
      primaryButton.textContent = terminalStates.has(state)
        ? "开始分析"
        : state === "queued"
          ? "排队中"
          : "正在分析";
    const dialog = progressDialog();
    if (dialog?.dataset.jobId === id && !terminalStates.has(state))
      boardText(
        dialog,
        "[data-board-connection]",
        jobSource?.readyState === 1
          ? "实时连接已建立，进度自动更新。"
          : "每 2 秒自动刷新，任务在后台继续运行。",
      );
    renderJobBoard(job, panel);
  } finally {
    refreshingJobs.delete(panel);
  }
}
function connectJobEvents(panel: HTMLElement): void {
  const id = panel.dataset.jobId;
  jobSource?.close();
  jobSource = null;
  sourceJobId = id ?? "";
  if (
    !id ||
    typeof EventSource === "undefined" ||
    terminalStates.has(panel.dataset.jobState ?? "")
  )
    return;
  try {
    const source = new EventSource(
      `/api/jobs/${encodeURIComponent(id)}/events`,
    );
    jobSource = source;
    const notify = () => {
      if (sourceJobId === id) void refreshJob(panel);
    };
    source.onmessage = notify;
    for (const type of ["state", "progress", "log", "done"])
      source.addEventListener(type, notify);
    source.onopen = () => {
      const dialog = progressDialog();
      if (dialog?.dataset.jobId === id)
        boardText(
          dialog,
          "[data-board-connection]",
          "实时连接已建立，进度自动更新。",
        );
    };
    source.onerror = () => {
      const dialog = progressDialog();
      if (
        dialog?.dataset.jobId === id &&
        !terminalStates.has(panel.dataset.jobState ?? "")
      )
        boardText(
          dialog,
          "[data-board-connection]",
          "实时连接暂不可用，正通过自动刷新恢复进度。",
        );
    };
  } catch {
    /* Polling keeps working without EventSource support. */
  }
}
function openJobPanel(panel: HTMLElement): void {
  const dialog = progressDialog(),
    id = panel.dataset.jobId;
  if (!dialog || !id) return;
  dialog.dataset.jobId = id;
  delete dialog.dataset.stepKey;
  delete dialog.dataset.activityKey;
  setStatus(dialog, "");
  if (!dialog.open) dialog.showModal();
  const url = new URL(window.location.href);
  url.searchParams.set("job", id);
  history.replaceState(null, "", url);
  const cached = jobViews.get(id);
  if (cached) renderJobBoard(cached, panel);
  else {
    for (const selector of ["[data-board-steps]", "[data-board-activities]"])
      dialog.querySelector(selector)?.replaceChildren();
    for (const selector of [
      "[data-board-error]",
      "[data-board-pages]",
      "[data-board-result]",
      "[data-board-job-action]",
    ])
      dialog.querySelectorAll<HTMLElement>(selector).forEach((element) => {
        element.hidden = true;
      });
    boardText(dialog, "[data-board-state]", "正在读取任务");
    for (const selector of [
      "[data-board-attempt]",
      "[data-board-elapsed]",
      "[data-board-updated]",
      "[data-board-meta]",
    ])
      boardText(dialog, selector, "");
    boardText(
      dialog,
      "[data-board-title]",
      panel.closest(".project-card")?.querySelector("h2")?.textContent ??
        "项目分析",
    );
    boardText(dialog, "[data-board-current]", "正在读取任务信息…");
  }
  connectJobEvents(panel);
  void refreshJob(panel);
}
async function jobAction(panel: HTMLElement, action: string): Promise<void> {
  const id = panel.dataset.jobId;
  if (!id || actingJobs.has(panel)) return;
  actingJobs.add(panel);
  const controls = [
    ...panel.querySelectorAll<HTMLButtonElement>("[data-job-action]"),
  ];
  const primaryJobButton = panel
    .closest(".project-card")
    ?.querySelector<HTMLButtonElement>("[data-primary-job-action]");
  if (primaryJobButton) controls.push(primaryJobButton);
  const dialog = progressDialog();
  if (dialog?.dataset.jobId === id)
    controls.push(
      ...dialog.querySelectorAll<HTMLButtonElement>("[data-board-job-action]"),
    );
  controls.forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = await requestJson(
      `/api/jobs/${encodeURIComponent(id)}/${action}`,
      "POST",
      {},
    );
    if (!result.ok)
      setStatus(
        dialog?.open && dialog.dataset.jobId === id ? dialog : panel,
        errorText(result.body),
        "error",
      );
    else {
      const updated = object(result.body);
      if (typeof updated.state === "string") {
        jobViews.set(id, updated);
        panel.dataset.jobState = updated.state;
        renderJobBoard(updated, panel);
      }
      if (action === "retry") {
        panel.dataset.jobState = "queued";
        openJobPanel(panel);
      }
      await refreshJob(panel);
    }
  } finally {
    actingJobs.delete(panel);
    controls.forEach((button) => {
      button.disabled = false;
    });
    const current = jobViews.get(id);
    if (current) {
      renderJobBoard(current, panel);
      const cancel = panel.querySelector<HTMLButtonElement>(
        "[data-job-action='cancel']",
      );
      if (cancel) cancel.disabled = current.state === "cancelling";
      const primary = panel
        .closest(".project-card")
        ?.querySelector<HTMLButtonElement>("[data-primary-job-action]");
      if (primary)
        primary.disabled = ["queued", "running", "cancelling"].includes(
          textOf(current.state),
        );
    }
  }
}
function wireJobs(): void {
  const panels = Array.from(
    document.querySelectorAll<HTMLElement>("[data-project-job]"),
  );
  panels.forEach((panel) => {
    if (panel.dataset.jobId) void refreshJob(panel);
    panel
      .closest(".project-card")
      ?.querySelector(".project-actions")
      ?.addEventListener("click", (event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>(
                "button[data-primary-job-action]",
              )
            : null;
        if (button && !button.disabled)
          void jobAction(panel, button.dataset.primaryJobAction ?? "");
      });
    panel
      .querySelector<HTMLButtonElement>("[data-open-job]")
      ?.addEventListener("click", () => openJobPanel(panel));
    panel
      .querySelectorAll<HTMLButtonElement>("[data-job-action]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          if (!button.disabled)
            void jobAction(panel, button.dataset.jobAction ?? "");
        }),
      );
  });
  const dialog = progressDialog();
  dialog?.addEventListener("close", () => {
    jobSource?.close();
    jobSource = null;
    sourceJobId = "";
    const url = new URL(window.location.href);
    url.searchParams.delete("job");
    history.replaceState(null, "", url);
  });
  dialog
    ?.querySelectorAll<HTMLButtonElement>("[data-board-job-action]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const panel = panels.find(
          (item) => item.dataset.jobId === dialog.dataset.jobId,
        );
        if (panel && !button.disabled)
          void jobAction(panel, button.dataset.boardJobAction ?? "");
      }),
    );
  const requested = new URLSearchParams(window.location.search).get("job");
  const selected = panels.find(
    (panel) => panel.dataset.jobId && panel.dataset.jobId === requested,
  );
  if (selected) openJobPanel(selected);
  if (panels.length) {
    const poll = window.setInterval(() => {
      if (document.hidden) return;
      panels.forEach((panel) => {
        if (
          panel.dataset.jobId &&
          !terminalStates.has(panel.dataset.jobState ?? "")
        )
          void refreshJob(panel);
      });
    }, 2000);
    const clock = window.setInterval(() => {
      if (!document.hidden) updateJobClock();
    }, 1000);
    window.addEventListener(
      "pagehide",
      () => {
        window.clearInterval(poll);
        window.clearInterval(clock);
        jobSource?.close();
      },
      { once: true },
    );
  }
}
function wireRemoval(): void {
  const panel = document.querySelector<HTMLElement>(
    "[data-testid='project-dependents']",
  );
  const form = document.querySelector<HTMLFormElement>("[data-remove-project]");
  if (!panel || !form) return;
  const confirm = form.querySelector<HTMLInputElement>(
    "input[type='checkbox']",
  );
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
  let loaded = false,
    request = 0;
  const update = () => {
    if (submit) submit.disabled = !loaded || !confirm?.checked;
  };
  confirm?.addEventListener("change", update);
  document
    .querySelectorAll<HTMLElement>("[data-select-project]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const id = button.dataset.selectProject ?? "";
        const version = ++request;
        loaded = false;
        if (confirm) confirm.checked = false;
        update();
        form.dataset.projectId = id;
        panel.dataset.projectId = id;
        const title = panel.querySelector("[data-removal-name]");
        if (title) title.textContent = button.dataset.projectName ?? "当前项目";
        const list = panel.querySelector(".dependent-list");
        if (list) list.textContent = "正在读取依赖…";
        const dialog = form.closest("dialog");
        if (dialog && !dialog.open) dialog.showModal();
        void requestJson(
          `/api/projects/${encodeURIComponent(id)}/dependents`,
        ).then((result) => {
          if (request !== version) return;
          if (!result.ok) {
            setStatus(panel, errorText(result.body));
            return;
          }
          if (list) {
            list.textContent = "";
            for (const [key, label] of [
              ["conversations", "会话"],
              ["lessons", "讲解"],
              ["generations", "生成版本"],
              ["changeEvents", "更新记录"],
            ]) {
              const item = document.createElement("li");
              item.textContent = `${label}：${Number(object(object(result.body)[key]).count ?? 0)}`;
              list.append(item);
            }
          }
          loaded = true;
          update();
        });
      }),
    );
  onSubmit(form, async () => {
    if (!loaded || !confirm?.checked || !form.dataset.projectId) {
      setStatus(form, "请先勾选确认，再移除项目。");
      return;
    }
    const result = await requestJson(
      `/api/projects/${encodeURIComponent(form.dataset.projectId)}?confirm=true`,
      "DELETE",
    );
    if (result.ok) window.location.assign("/");
    else setStatus(form, errorText(result.body));
  });
}
function saveLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private browsing may disable storage. */
  }
}
function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function readerPanel(panel: "qa" | "source" | "reading" | "nav"): void {
  const grid = document.querySelector<HTMLElement>(".reader-grid");
  if (!grid) return;
  grid.dataset.readerPanel =
    panel === "qa" || panel === "source" ? panel : "closed";
  grid.dataset.mobilePane = panel;
  const source = document.querySelector<HTMLElement>("[data-source-panel]");
  if (source) source.hidden = panel !== "source";
  document
    .querySelectorAll<HTMLElement>("[data-reader-pane]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.readerPane === panel),
      ),
    );
  if (window.matchMedia?.("(max-width: 900px)")?.matches)
    grid.scrollIntoView({ block: "start", behavior: "instant" });
}
function selectSource(
  sourceId: string,
  commitSha: string,
  label: string,
  sourceIds: string[] = [sourceId],
): void {
  const source = document.querySelector<HTMLInputElement>(
    "[data-qa-selection-source]",
  );
  const commit = document.querySelector<HTMLInputElement>(
    "[data-qa-selection-commit]",
  );
  const ids = document.querySelector<HTMLInputElement>(
    "[data-qa-selection-source-ids]",
  );
  if (source) source.value = sourceId;
  if (commit) commit.value = commitSha;
  if (ids) ids.value = sourceIds.join(",");
  const context = document.querySelector<HTMLElement>(
    "[data-qa-selection-label]",
  );
  if (context) {
    context.hidden = false;
    context.textContent = `已选：${label}`;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "quiet";
    clear.textContent = "清除";
    clear.addEventListener("click", () => {
      if (source) source.value = "";
      if (commit) commit.value = "";
      if (ids) ids.value = "";
      context.hidden = true;
    });
    context.append(" ", clear);
  }
  readerPanel("qa");
  document
    .querySelector<HTMLTextAreaElement>("[data-testid='qa-input']")
    ?.focus();
}
function wireDiagramSelection(): void {
  document
    .querySelectorAll<HTMLElement>("[data-diagram-node]")
    .forEach((node) => {
      const select = () => {
        const ids = (node.dataset.evidenceIds ?? "").split(",").filter(Boolean);
        selectSource(
          ids[0] ?? "",
          node.dataset.commitSha ?? "",
          node.textContent ?? "图中模块",
          ids,
        );
        document
          .querySelectorAll("[data-diagram-node]")
          .forEach((item) =>
            item.setAttribute("aria-pressed", String(item === node)),
          );
      };
      node.addEventListener("click", select);
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
    });
}
let sourceRequest = 0;
async function openSource(url: URL, push = true): Promise<void> {
  const panel = document.querySelector<HTMLElement>("[data-source-panel]");
  if (!panel) return;
  const generation = url.searchParams.get("generation") ?? "";
  const sourceId = url.searchParams.get("source") ?? "";
  if (!generation || !sourceId) return;
  const request = ++sourceRequest;
  readerPanel("source");
  const status = panel.querySelector("[data-source-status]");
  const content = panel.querySelector("[data-source-content]");
  const label = panel.querySelector("[data-source-label]");
  const version = panel.querySelector("[data-source-version]");
  const ask = panel.querySelector<HTMLButtonElement>("[data-source-ask]");
  if (content) content.textContent = "";
  if (label) label.textContent = "代码证据";
  if (version) version.textContent = "";
  if (status) status.textContent = "正在读取固定版本来源…";
  if (ask) ask.disabled = true;
  if (push) {
    const current = new URL(window.location.href);
    current.searchParams.set("generation", generation);
    current.searchParams.set("source", sourceId);
    history.pushState(null, "", current);
  }
  const result = await requestJson(
    `/api/generations/${encodeURIComponent(generation)}/sources/${encodeURIComponent(sourceId)}`,
  );
  if (request !== sourceRequest) return;
  if (!result.ok) {
    if (status) status.textContent = errorText(result.body);
    return;
  }
  const source = object(result.body);
  if (content) content.textContent = textOf(source.content);
  if (label) label.textContent = textOf(source.label);
  const lines = object(source.lines);
  if (version)
    version.textContent = `提交 ${textOf(source.commitSha).slice(0, 12)}${lines.start ? ` · 行 ${textOf(lines.start)}–${textOf(lines.end)}` : ""}`;
  if (status)
    status.textContent =
      source.availability !== "available"
        ? "来源已不可用"
        : source.truncated
          ? "内容较长，已截断"
          : "";
  if (ask) {
    ask.disabled = source.availability !== "available";
    ask.dataset.sourceId = sourceId;
    ask.dataset.commitSha = textOf(source.commitSha);
  }
}
function wireReader(): void {
  const grid = document.querySelector<HTMLElement>(".reader-grid");
  if (!grid) return;
  grid.dataset.enhanced = "true";
  readerPanel(
    grid.dataset.readerPanel === "qa"
      ? "qa"
      : grid.dataset.readerPanel === "source"
        ? "source"
        : "reading",
  );
  document
    .querySelectorAll<HTMLElement>("[data-reader-pane]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const pane = button.dataset.readerPane;
        if (
          pane === "qa" ||
          pane === "reading" ||
          pane === "nav" ||
          pane === "source"
        )
          readerPanel(pane);
      }),
    );
  document
    .querySelectorAll<HTMLElement>("[data-reader-close]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        ++sourceRequest;
        readerPanel("reading");
        const url = new URL(window.location.href);
        url.searchParams.delete("source");
        history.pushState(null, "", url);
      }),
    );
  document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a[data-source-link]",
    );
    if (!link) return;
    if (
      (event as MouseEvent).metaKey ||
      (event as MouseEvent).ctrlKey ||
      (event as MouseEvent).shiftKey
    )
      return;
    const url = new URL(link.href);
    if (url.searchParams.get("generation") !== grid.dataset.generationId)
      return;
    event.preventDefault();
    void openSource(url);
  });
  document
    .querySelector<HTMLElement>("[data-source-ask]")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLElement;
      selectSource(
        button.dataset.sourceId ?? "",
        button.dataset.commitSha ?? "",
        document.querySelector("[data-source-label]")?.textContent ??
          "当前代码",
      );
    });
  window.addEventListener("popstate", () => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("source")) void openSource(url, false);
    else {
      ++sourceRequest;
      readerPanel("reading");
    }
  });
  const article = document.querySelector<HTMLElement>(
    "[data-testid='reader-lesson']",
  );
  const saved = Number(article?.dataset.readingPosition ?? 0);
  if (saved > 0) window.scrollTo({ top: saved, behavior: "instant" });
  let saveTimer: number | undefined;
  window.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        if (
          !grid.dataset.generationId ||
          !grid.dataset.lessonId ||
          article?.getClientRects().length === 0
        )
          return;
        void requestJson("/api/preferences", "PUT", {
          readingPosition: {
            generationId: grid.dataset.generationId,
            lessonId: grid.dataset.lessonId,
            offset: Math.max(0, Math.round(window.scrollY)),
          },
        });
      }, 800);
    },
    { passive: true },
  );
}
async function consumeSse(
  response: Response,
  onEvent: (event: JsonObject) => void,
): Promise<void> {
  if (!response.body) throw new Error("服务器没有返回回答流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frame = (text: string) => {
    const data = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("回答流格式无效。");
    }
    onEvent(object(event));
  };
  try {
    for (;;) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (next.done) {
        if (buffer.trim()) frame(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function appendMessage(role: string, text: string): HTMLElement | null {
  const stream = document.querySelector<HTMLElement>(
    "[data-testid='qa-stream']",
  );
  if (!stream) return null;
  stream.querySelectorAll(".empty").forEach((node) => node.remove());
  const item = document.createElement("li");
  item.className = "qa-message";
  item.dataset.role = role;
  const label = document.createElement("span");
  label.className = "qa-role";
  label.textContent = role === "assistant" ? "助手" : "你";
  const content = document.createElement("div");
  content.className = "qa-content";
  content.textContent = text;
  item.append(label, content);
  stream.append(item);
  stream.scrollTop = stream.scrollHeight;
  return content;
}
function appendInlineCitations(
  content: HTMLElement,
  citations: unknown[],
): void {
  if (!citations.length) return;
  const list = document.createElement("ul");
  list.className = "message-citations";
  for (const raw of citations) {
    const citation = object(raw);
    if (
      typeof citation.sourceId !== "string" ||
      typeof citation.generationId !== "string"
    )
      continue;
    const entry = document.createElement("li"),
      link = document.createElement("a");
    link.dataset.sourceLink = "true";
    link.href = `/learn/reader?generation=${encodeURIComponent(citation.generationId)}&source=${encodeURIComponent(citation.sourceId)}`;
    link.textContent = textOf(citation.label, "查看代码依据");
    entry.append(link);
    list.append(entry);
  }
  content.closest(".qa-message")?.append(list);
}
function renderConversation(body: JsonObject): void {
  const stream = document.querySelector<HTMLElement>(
    "[data-testid='qa-stream']",
  );
  if (stream) stream.textContent = "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const message = object(raw);
    appendMessage(textOf(message.role, "assistant"), textOf(message.content));
  }
  const citations = object(
    messages.filter((raw) => object(raw).role === "assistant").at(-1),
  ).citations;
  renderCitations(Array.isArray(citations) ? citations : []);
}
function renderCitations(citations: unknown[]): void {
  const list = document.querySelector<HTMLElement>(
    "[data-testid='qa-citations']",
  );
  if (!list) return;
  list.textContent = "";
  if (!citations.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "尚无引用。";
    list.append(empty);
  }
  for (const raw of citations) {
    const citation = object(raw);
    if (
      typeof citation.sourceId !== "string" ||
      typeof citation.generationId !== "string"
    )
      continue;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.dataset.sourceLink = "true";
    link.href = `/learn/reader?generation=${encodeURIComponent(citation.generationId)}&source=${encodeURIComponent(citation.sourceId)}`;
    link.textContent = textOf(citation.label, "查看代码依据");
    item.append(link);
    if (citation.availability && citation.availability !== "available")
      item.append("（来源不可用）");
    list.append(item);
  }
}
function wireQaForm(): void {
  const form = document.querySelector<HTMLFormElement>("[data-qa-form]");
  if (!form) return;
  const input = form.querySelector<HTMLTextAreaElement>(
    "[data-testid='qa-input']",
  );
  const stop = form.querySelector<HTMLButtonElement>("[data-qa-stop]");
  let active: AbortController | null = null;
  const generation = form.dataset.generationId ?? "";
  const topicId = form.dataset.topicId ?? "";
  const storageKey = topicId
    ? `codetrail:topic-conversation:${topicId}`
    : `codetrail:conversation:${generation}`;
  const bind = (id: string) => {
    form.dataset.conversationId = id;
    if (topicId) return;
    saveLocal(storageKey, id);
    const url = new URL(window.location.href);
    url.searchParams.set("generation", generation);
    url.searchParams.set("conversation", id);
    history.replaceState(null, "", url);
    document
      .querySelectorAll<HTMLAnchorElement>(".lesson-nav a")
      .forEach((link) => {
        const next = new URL(link.href);
        if (next.searchParams.has("topic")) return;
        next.searchParams.set("conversation", id);
        link.href = next.href;
      });
  };
  let restoring: Promise<void> = Promise.resolve();
  if (form.dataset.conversationId) bind(form.dataset.conversationId);
  else if (!topicId) {
    const saved = readLocal(storageKey);
    if (saved && generation) {
      restoring = requestJson(
        `/api/conversations/${encodeURIComponent(saved)}`,
      ).then((result) => {
        const view = object(result.body);
        if (
          result.ok &&
          Array.isArray(view.generationIds) &&
          view.generationIds.includes(generation)
        ) {
          bind(saved);
          renderConversation(view);
        }
      });
    }
  }
  stop?.addEventListener("click", () => active?.abort());
  window.addEventListener("pagehide", () => active?.abort(), { once: true });
  onSubmit(form, async () => {
    await restoring;
    if (form.dataset.topicDraft === "true") {
      setStatus(form, "请先在正文区域提交第一个问题。");
      return;
    }
    const text = input?.value.trim() ?? "";
    if (!text) {
      setStatus(form, "请先输入问题。");
      return;
    }
    if (!generation) {
      setStatus(form, "请先生成项目讲解。");
      return;
    }
    let id = form.dataset.conversationId ?? "";
    if (!id) {
      const created = await requestJson("/api/conversations", "POST", {
        generationIds: [generation],
        ...(form.dataset.lessonId ? { lessonId: form.dataset.lessonId } : {}),
      });
      const next = object(created.body).conversationId;
      if (!created.ok || typeof next !== "string") {
        setStatus(form, errorText(created.body, "无法创建会话。"));
        return;
      }
      id = next;
      bind(id);
    }
    const source =
      form.querySelector<HTMLInputElement>("[data-qa-selection-source]")
        ?.value ?? "";
    const ids = (
      form.querySelector<HTMLInputElement>("[data-qa-selection-source-ids]")
        ?.value ?? ""
    )
      .split(",")
      .filter(Boolean);
    const commit =
      form.querySelector<HTMLInputElement>("[data-qa-selection-commit]")
        ?.value ?? "";
    const payload = {
      text,
      ...(source
        ? {
            selection: {
              sourceId: source,
              ...(ids.length ? { sourceIds: ids } : {}),
              ...(commit ? { commitSha: commit } : {}),
            },
          }
        : {}),
    };
    active = new AbortController();
    if (stop) stop.hidden = false;
    readerPanel("qa");
    appendMessage("user", text);
    const answer = appendMessage("assistant", "");
    let content = "",
      ended = false,
      failed = false,
      streamError = "";
    setStatus(form, "正在检索证据并生成回答…");
    try {
      const response = await fetch(
        topicId
          ? `/api/topics/${encodeURIComponent(topicId)}/messages`
          : `/api/conversations/${encodeURIComponent(id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: active.signal,
        },
      );
      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          /* Keep generic status. */
        }
        throw new Error(errorText(body));
      }
      await consumeSse(response, (event) => {
        if (event.type === "delta" && typeof event.text === "string") {
          content += event.text;
          if (answer) answer.textContent = content;
        }
        if (event.type === "error") {
          failed = true;
          streamError =
            typeof event.message === "string"
              ? event.message
              : errorText(event);
          setStatus(form, streamError);
        }
        if (event.type === "done" && typeof event.status === "string") {
          ended = true;
          failed = failed || event.status !== "complete";
          setStatus(
            form,
            event.status === "cancelled"
              ? "已停止生成。"
              : failed
                ? streamError || "回答未通过检查，请查看内容并重试。"
                : event.incomplete
                  ? "回答已保存，部分内容未覆盖。"
                  : "回答已保存，可以继续追问。",
          );
        }
      });
      if (!ended && !failed)
        throw new Error("连接已中断，已收到的内容已保留，可重试。");
      if (ended && !failed && input) input.value = "";
      // Re-read durable citations and final states; keep the live answer in place.
      const saved = await requestJson(
        `/api/conversations/${encodeURIComponent(id)}`,
      );
      if (saved.ok) {
        const messages = object(saved.body).messages;
        if (Array.isArray(messages)) {
          const citations = object(
            messages.filter((raw) => object(raw).role === "assistant").at(-1),
          ).citations;
          const list = Array.isArray(citations) ? citations : [];
          renderCitations(list);
          if (answer) appendInlineCitations(answer, list);
        }
      }
    } catch (error) {
      setStatus(
        form,
        active.signal.aborted
          ? "已停止生成，已收到的内容已保留。"
          : error instanceof Error
            ? error.message
            : "发送失败。",
      );
    } finally {
      active = null;
      if (stop) stop.hidden = true;
    }
  });
}
function wireModelConnection(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>("[data-model-test]");
  if (!button) return;
  button.addEventListener("click", () => {
    if (submitting.has(form)) return;
    for (const name of ["model", "baseUrl"]) {
      const field = form.querySelector<HTMLInputElement>(`[name='${name}']`);
      if (field && !field.reportValidity()) return;
    }
    const apiKey = valueOf(form, "apiKey");
    if (
      valueOf(form, "provider") === "anthropic" &&
      !apiKey &&
      form.dataset.apiKeyConfigured !== "true"
    ) {
      setStatus(
        form,
        "请输入 API Key，或在启动服务前配置 ANTHROPIC_API_KEY。",
        "error",
      );
      return;
    }
    const payload = {
      provider: valueOf(form, "provider"),
      model: valueOf(form, "model"),
      baseUrl: valueOf(form, "baseUrl") || null,
      ...(apiKey ? { apiKey } : {}),
    };
    const fields = Array.from(form.elements).filter(
      (
        field,
      ): field is HTMLInputElement | HTMLSelectElement | HTMLButtonElement =>
        field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement ||
        field instanceof HTMLButtonElement,
    );
    const disabled = fields.map((field) => field.disabled);
    submitting.add(form);
    fields.forEach((field) => {
      field.disabled = true;
    });
    form.setAttribute("aria-busy", "true");
    button.textContent = "测试中…";
    setStatus(form, "正在测试连接，最长等待 10 秒…");
    void requestJson("/api/settings/model/test", "POST", payload)
      .then((result) => {
        const data = object(result.body);
        setStatus(
          form,
          result.ok && data.ok === true
            ? `${textOf(data.message, "连接成功。")} 耗时 ${textOf(data.latencyMs, "—")} ms。`
            : errorText(result.body, "连接测试失败，请检查服务配置。"),
          result.ok && data.ok === true ? "success" : "error",
        );
      })
      .catch(() => setStatus(form, "连接测试失败，请重试。", "error"))
      .finally(() => {
        fields.forEach((field, index) => {
          field.disabled = disabled[index];
        });
        submitting.delete(form);
        form.removeAttribute("aria-busy");
        button.textContent = "测试连接";
      });
  });
  form.addEventListener("input", () => {
    if (!submitting.has(form))
      setStatus(form, "配置已修改，可重新测试连接或保存。");
  });
}

function wireSettings(): void {
  const model = document.querySelector<HTMLFormElement>(
    "[data-model-settings-form]",
  );
  if (model) {
    wireModelConnection(model);
    onSubmit(model, async () => {
      const key = valueOf(model, "apiKey");
      if (
        valueOf(model, "provider") === "anthropic" &&
        !key &&
        model.dataset.apiKeyConfigured !== "true"
      ) {
        setStatus(
          model,
          "请输入 API Key，或在启动服务前配置 ANTHROPIC_API_KEY。",
          "error",
        );
        return;
      }
      const result = await requestJson("/api/settings/model", "PUT", {
        provider: valueOf(model, "provider"),
        model: valueOf(model, "model"),
        baseUrl: valueOf(model, "baseUrl") || null,
        ...(key ? { apiKey: key } : {}),
        maxOutputTokens: Number(valueOf(model, "maxOutputTokens")),
        temperature: Number(valueOf(model, "temperature")),
        quota: {
          maxCalls: Number(valueOf(model, "maxCalls")),
          maxInputTokens: Number(valueOf(model, "maxInputTokens")),
          maxOutputTokens: Number(valueOf(model, "quotaMaxOutputTokens")),
        },
      });
      setStatus(
        model,
        result.ok
          ? "已保存，对新任务立即生效。现在可以返回项目开始分析。"
          : errorText(result.body),
        result.ok ? "success" : "error",
      );
      if (result.ok) {
        const field = model.querySelector<HTMLInputElement>("[name='apiKey']");
        if (field) {
          field.value = "";
          const configured = object(result.body).apiKeyConfigured === true;
          model.dataset.apiKeyConfigured = String(configured);
          field.placeholder = configured
            ? "已配置，留空保留现有 Key"
            : "输入 API Key，或使用已配置的环境变量";
        }
      }
    });
  }
  const prefs = document.querySelector<HTMLFormElement>(
    "[data-preferences-form]",
  );
  if (prefs)
    onSubmit(prefs, async () => {
      const result = await requestJson("/api/preferences", "PUT", {
        explainLevel: valueOf(prefs, "explainLevel"),
        background: valueOf(prefs, "background"),
      });
      setStatus(prefs, result.ok ? "已保存。" : errorText(result.body));
    });
  const legacy = document.querySelector<HTMLFormElement>(
    "[data-reading-position-form]",
  );
  if (legacy)
    onSubmit(legacy, async () => {
      const offset = Number(valueOf(legacy, "offset"));
      if (
        !legacy.dataset.generationId ||
        !legacy.dataset.lessonId ||
        !Number.isFinite(offset)
      ) {
        setStatus(legacy, "阅读位置无效。");
        return;
      }
      const result = await requestJson("/api/preferences", "PUT", {
        readingPosition: {
          generationId: legacy.dataset.generationId,
          lessonId: legacy.dataset.lessonId,
          offset,
        },
      });
      setStatus(legacy, result.ok ? "已保存。" : errorText(result.body));
    });
  const panel = document.querySelector<HTMLElement>("[data-watch-panel]");
  const toggle = document.querySelector<HTMLInputElement>(
    "[data-testid='settings-watch-toggle']",
  );
  const refresh = document.querySelector<HTMLButtonElement>(
    "[data-testid='settings-watch-refresh']",
  );
  if (panel) {
    toggle?.addEventListener("change", () => {
      const previous = !toggle.checked;
      toggle.disabled = true;
      void requestJson(
        `/api/projects/${encodeURIComponent(panel.dataset.projectId ?? "")}/watch`,
        "PUT",
        { enabled: toggle.checked },
      )
        .then((result) => {
          if (!result.ok) {
            toggle.checked = previous;
            setStatus(panel, errorText(result.body));
          } else setStatus(panel, "跟进设置已保存。");
        })
        .finally(() => {
          toggle.disabled = false;
        });
    });
    refresh?.addEventListener("click", () => {
      if (refresh.disabled) return;
      refresh.disabled = true;
      void requestJson(
        `/api/projects/${encodeURIComponent(panel.dataset.projectId ?? "")}/watch`,
        "PUT",
        { enabled: true, refreshNow: true },
      )
        .then((result) => {
          setStatus(
            panel,
            result.ok
              ? "更新检查已完成，发现的任务将自动分析。"
              : errorText(result.body),
          );
          if (result.ok && toggle) toggle.checked = true;
        })
        .finally(() => {
          refresh.disabled = false;
        });
    });
  }
  document
    .querySelector<HTMLSelectElement>("[data-project-switch]")
    ?.addEventListener("change", (event) => {
      const url = new URL(window.location.href);
      url.searchParams.set(
        "project",
        (event.target as HTMLSelectElement).value,
      );
      url.searchParams.delete("cursor");
      window.location.assign(url.href);
    });
}
function main(): void {
  document
    .querySelector<HTMLInputElement>("[data-term-filter]")
    ?.addEventListener("input", (event) => {
      const value = (event.target as HTMLInputElement).value
        .trim()
        .toLocaleLowerCase();
      let count = 0;
      document
        .querySelectorAll<HTMLElement>(".terms-table tbody tr[data-term-id]")
        .forEach((row) => {
          row.hidden = !(row.textContent ?? "")
            .toLocaleLowerCase()
            .includes(value);
          if (!row.hidden) count++;
        });
      const empty = document.querySelector<HTMLElement>("[data-term-empty]");
      if (empty) empty.hidden = count !== 0;
    });
  wireDialogs();
  wireLessonManagement();
  wireTopics();
  wireProjectForms();
  wireJobs();
  wireRemoval();
  wireDiagramSelection();
  wireReader();
  wireQaForm();
  wireSettings();
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", main, { once: true });
else main();
export {};
