// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- browser API doubles */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { pageContext, projectsModel, projectSummary } from "./fixtures.ts";

class FakeEvents extends EventTarget {
  static instances: FakeEvents[] = [];
  readyState = 1;
  onmessage: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEvents.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
}
const JOB = "j_progress";
let job: Record<string, unknown>;
let disconnected: boolean;
let requests: { url: string; method: string }[];
beforeEach(() => {
  vi.resetModules();
  FakeEvents.instances = [];
  requests = [];
  disconnected = false;
  job = {
    jobId: JOB,
    kind: "generation_initial",
    state: "running",
    attempt: 1,
    createdAt: new Date(Date.now() - 90000).toISOString(),
    startedAt: new Date(Date.now() - 80000).toISOString(),
    finishedAt: null,
    retryable: false,
    progress: {
      phase: "pages",
      seq: 4,
      message: "读取文件：src/auth.ts",
      pages: { done: 2, total: 8, current: "openwiki/auth.md" },
      updatedAt: new Date().toISOString(),
      activities: [
        {
          seq: 4,
          at: new Date().toISOString(),
          attempt: 1,
          phase: "pages",
          message: "读取文件：src/auth.ts",
        },
      ],
    },
  };
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  vi.stubGlobal("EventSource", FakeEvents);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push({ url, method: options?.method ?? "GET" });
      if (disconnected) throw new Error("offline");
      if (url.endsWith("/cancel"))
        job = {
          ...job,
          state: "cancelled",
          retryable: true,
          finishedAt: new Date().toISOString(),
        };
      if (url.endsWith("/retry"))
        job = {
          ...job,
          state: "queued",
          attempt: 2,
          retryable: false,
          startedAt: null,
          finishedAt: null,
          progress: {
            phase: "queued",
            seq: 8,
            message: "任务已排队",
            activities: [],
          },
        };
      const body: unknown = structuredClone(job);
      return { ok: true, json: async () => body };
    }),
  );
  history.replaceState(null, "", `/?job=${JOB}`);
  document.open();
  document.write(
    renderProjectsPage(
      pageContext,
      projectsModel({
        projects: [
          projectSummary({
            latestJobId: JOB as never,
            latestJobState: "running",
            analyzedCommitSha: null,
          }),
        ],
      }),
    ),
  );
  document.close();
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const dialog = () =>
  document.querySelector<HTMLDialogElement>("#analysis-progress")!;
const load = () => import("../../../src/learning/ui/client.ts");

describe("analysis process panel", () => {
  it("restores the selected job, shows real counts, and closing never cancels analysis", async () => {
    await load();
    await vi.waitFor(() =>
      expect(dialog().textContent).toContain("已完成 2 / 8 篇"),
    );
    expect(dialog().open).toBe(true);
    expect(
      dialog().querySelector("[aria-current='step']")?.textContent,
    ).toContain("生成项目文档");
    expect(
      dialog().querySelector("[data-board-elapsed]")?.textContent,
    ).toContain("1分");
    expect(
      dialog().querySelector("[data-board-activities]")?.textContent,
    ).toContain("src/auth.ts");
    dialog().querySelector<HTMLButtonElement>("[data-close-dialog]")!.click();
    expect(dialog().open).toBe(false);
    expect(new URLSearchParams(location.search).has("job")).toBe(false);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-open-job]")!.click();
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain("已完成 2 / 8 篇");
  });

  it("shows deferred pages separately instead of calling them completed", async () => {
    job = {
      ...job,
      progress: {
        phase: "pages",
        pages: { done: 6, total: 22, processed: 7, skipped: 1 },
      },
    };
    await load();
    await vi.waitFor(() =>
      expect(dialog().textContent).toContain("已完成 6 / 22 篇 · 待重试 1 篇"),
    );
    expect(
      dialog().querySelector<HTMLProgressElement>("[data-board-page-progress]")
        ?.value,
    ).toBe(7);
  });

  it("offers checkpoint continuation for a stopped job with saved work", async () => {
    job = {
      ...job,
      state: "cancelled",
      retryable: true,
      progress: {
        phase: "pages",
        resumeAvailable: true,
        pages: { done: 7, total: 22 },
      },
    };
    await load();
    await vi.waitFor(() =>
      expect(
        dialog().querySelector("[data-board-job-action='retry']")?.textContent,
      ).toBe("从断点继续"),
    );
    expect(dialog().textContent).toContain("断点和已生成文件已保存在本机");
  });

  it("continues the original job from the primary card button without submitting a new analysis", async () => {
    job = {
      ...job,
      state: "cancelled",
      retryable: true,
      progress: {
        phase: "pages",
        resumeAvailable: true,
        pages: { done: 7, total: 22 },
      },
    };
    await load();
    const primary = document.querySelector<HTMLButtonElement>(
      ".project-actions button.primary",
    )!;
    await vi.waitFor(() => expect(primary.textContent).toBe("从断点继续"));
    expect(primary.disabled).toBe(false);
    primary.click();
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.method === "POST")).toEqual([
        { url: `/api/jobs/${JOB}/retry`, method: "POST" },
      ]),
    );
    await vi.waitFor(() => expect(primary.textContent).toBe("正在分析"));
    expect(primary.disabled).toBe(true);
    expect(dialog().open).toBe(true);
  });

  it("consumes named SSE progress events, preserves state offline, and links completed results", async () => {
    await load();
    await vi.waitFor(() =>
      expect(dialog().textContent).toContain("已完成 2 / 8 篇"),
    );
    const events = FakeEvents.instances[0];
    disconnected = true;
    events.onerror?.();
    events.dispatchEvent(new Event("progress"));
    await vi.waitFor(() =>
      expect(
        dialog().querySelector("[data-board-connection]")?.textContent,
      ).toContain("正在重试"),
    );
    expect(dialog().querySelector("[data-board-state]")?.textContent).toBe(
      "正在分析",
    );
    disconnected = false;
    job = {
      ...job,
      state: "completed",
      outputGenerationId: "g_ready",
      finishedAt: new Date().toISOString(),
      progress: {
        phase: "publishing",
        seq: 10,
        message: "分析完成",
        pages: { done: 8, total: 8 },
        activities: [
          {
            seq: 10,
            at: new Date().toISOString(),
            phase: "publishing",
            attempt: 1,
            message: "<img src=x onerror=alert(1)>",
          },
        ],
      },
    };
    events.dispatchEvent(new Event("state"));
    await vi.waitFor(() =>
      expect(dialog().querySelector("[data-board-state]")?.textContent).toBe(
        "已完成",
      ),
    );
    expect(
      dialog()
        .querySelector<HTMLAnchorElement>("[data-board-result]")
        ?.getAttribute("href"),
    ).toBe("/learn/reader?generation=g_ready");
    expect(dialog().querySelector("[data-board-activities] img")).toBeNull();
    expect(
      dialog().querySelector("[data-board-activities]")?.textContent,
    ).toContain("<img");
    expect(events.readyState).toBe(2);
  });

  it("cancels and retries through existing actions without keeping the old phase or counter", async () => {
    await load();
    await vi.waitFor(() =>
      expect(dialog().textContent).toContain("已完成 2 / 8 篇"),
    );
    dialog()
      .querySelector<HTMLButtonElement>("[data-board-job-action='cancel']")!
      .click();
    await vi.waitFor(() =>
      expect(dialog().querySelector("[data-board-state]")?.textContent).toBe(
        "已取消",
      ),
    );
    const retry = dialog().querySelector<HTMLButtonElement>(
      "[data-board-job-action='retry']",
    )!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await vi.waitFor(() =>
      expect(dialog().querySelector("[data-board-state]")?.textContent).toBe(
        "排队中",
      ),
    );
    expect(
      dialog().querySelector("[data-board-attempt]")?.textContent,
    ).toContain("第 2 次");
    expect(
      dialog().querySelector<HTMLElement>("[data-board-pages]")?.hidden,
    ).toBe(true);
    expect(dialog().querySelector("[aria-current='step']")).toBeNull();
    expect(
      requests
        .filter((request) => request.method === "POST")
        .map((request) => request.url),
    ).toEqual([`/api/jobs/${JOB}/cancel`, `/api/jobs/${JOB}/retry`]);
  });
});
