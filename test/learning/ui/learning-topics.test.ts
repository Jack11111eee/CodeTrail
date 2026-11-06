// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- browser doubles */
import { TextEncoder, TextDecoder } from "node:util";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningTopicView } from "../../../src/learning/contracts/index.ts";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import {
  GENERATION_ID,
  pageContext,
  readerModel,
  conversation,
  message,
} from "./fixtures.ts";
const topic = (patch: Partial<LearningTopicView> = {}): LearningTopicView => ({
  topicId: "lt_test",
  generationId: GENERATION_ID,
  conversationId: conversation().conversationId,
  title: null,
  autoTitle: true,
  firstQuestion: null,
  lessonMessageId: null,
  state: "draft",
  error: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
  displayTitle: "未命名主题",
  lesson: null,
  ...patch,
});
function render(t: LearningTopicView | null = null) {
  document.open();
  document.write(
    renderReaderPage(
      pageContext,
      readerModel({
        readingPosition: null,
        activeTopic: t,
        topics: t ? [t] : [],
        conversation: t
          ? { ...conversation(), conversationId: t.conversationId }
          : null,
        activeLesson: t ? null : readerModel().activeLesson,
      }),
    ),
  );
  document.close();
}
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  );
  return {
    ok: true,
    body: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  };
}
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("TextEncoder", TextEncoder);
  vi.stubGlobal("TextDecoder", TextDecoder);
  history.replaceState(null, "", `/learn/reader?generation=${GENERATION_ID}`);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
    },
  });
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("learning topic UI", () => {
  it("opens the create dialog, accepts an empty title and prevents double creation", async () => {
    render();
    let finish!: (r: ReturnType<typeof json>) => void;
    const fetch = vi.fn(
      () =>
        new Promise<ReturnType<typeof json>>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const open = document.querySelector<HTMLButtonElement>(
      "[data-open-dialog='create-topic']",
    )!;
    open.click();
    const dialog = document.querySelector<HTMLDialogElement>("#create-topic")!;
    expect(dialog.open).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    expect(
      form.querySelector<HTMLInputElement>("[name='title']")?.required,
    ).toBe(false);
    submit(form);
    submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      `/api/generations/${GENERATION_ID}/topics`,
      { method: "POST", body: JSON.stringify({ title: "" }) },
    ]);
    finish(json({ error: { message: "临时保存失败" } }, false));
    await vi.waitFor(() => expect(form.textContent).toContain("临时保存失败"));
    expect(dialog.open).toBe(true);
  });
  it("shows the first-question flow, retains failed text for retry and never restores a different topic's cached conversation", async () => {
    localStorage.setItem(`codetrail:conversation:${GENERATION_ID}`, "c_other");
    render(topic());
    const fetch = vi.fn(async () =>
      stream([
        { type: "error", message: "模型临时失败" },
        { type: "done", status: "failed" },
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector("h1")?.textContent).toBe("未命名主题");
    expect(
      document.querySelector(".reader-grid")?.getAttribute("data-reader-panel"),
    ).toBe("closed");
    const form = document.querySelector<HTMLFormElement>(
      "[data-topic-question]",
    )!;
    const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "风险评分如何流转？";
    submit(form);
    submit(form);
    await vi.waitFor(() => expect(form.textContent).toContain("模型临时失败"));
    expect(input.value).toBe("风险评分如何流转？");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      "/api/topics/lt_test/messages",
      { body: JSON.stringify({ text: input.value }) },
    ]);
    submit(form);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(
      localStorage.getItem(`codetrail:conversation:${GENERATION_ID}`),
    ).toBe("c_other");
    expect(
      document.querySelector(".lesson-nav a")?.getAttribute("href"),
    ).not.toContain("conversation=");
  });
  it("keeps the saved article while routing follow-ups to the topic's own conversation", async () => {
    const t = topic({
      state: "ready",
      title: "风险评分过程",
      displayTitle: "风险评分过程",
      lesson: message({ content: "已保存的正文" }),
      lessonMessageId: message().messageId,
    });
    render(t);
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/messages")
        ? stream([
            { type: "delta", text: "新的追问回答" },
            { type: "done", status: "complete" },
          ])
        : json({ messages: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>("[data-qa-form]")!;
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "失败时呢？";
    submit(form);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0][0]).toBe("/api/topics/lt_test/messages");
    expect(document.querySelector(".topic-article")?.textContent).toContain(
      "已保存的正文",
    );
    expect(document.querySelector(".qa-stream")?.textContent).toContain(
      "新的追问回答",
    );
    expect(location.search).not.toContain("conversation=");
    expect(
      document.querySelector(".lesson-nav a")?.getAttribute("href"),
    ).not.toContain(t.conversationId);
  });
  it("renders topic deletion and restore controls independently from automatic lessons", () => {
    const t = topic({
      state: "failed",
      firstQuestion: "保留的问题",
      error: "请求失败",
    });
    render(t);
    expect(
      document.querySelector<HTMLTextAreaElement>("#topic-question")?.value,
    ).toBe("保留的问题");
    expect(document.querySelector("[data-delete-topic]")).not.toBeNull();
    expect(document.querySelector("[data-delete-lesson]")).toBeNull();
    document.body.innerHTML = renderReaderPage(
      pageContext,
      readerModel({
        topics: [],
        deletedTopics: [{ ...t, deletedAt: "2026-01-02T00:00:00Z" }],
      }),
    );
    expect(
      document
        .querySelector("[data-restore-topic]")
        ?.getAttribute("data-restore-topic"),
    ).toBe(t.topicId);
  });
});
