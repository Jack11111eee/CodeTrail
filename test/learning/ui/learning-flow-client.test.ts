// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- async browser API doubles */
import { TextDecoder, TextEncoder } from "node:util";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";
import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import {
  pageContext,
  readerModel,
  projectsModel,
  settingsModel,
  GENERATION_ID,
} from "./fixtures.ts";
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
function stream(events: unknown[]) {
  const encoder = new TextEncoder();
  const text = events
    .map((event) => `event: message\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const bytes = encoder.encode(text);
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
  };
}
function render(html: string) {
  document.open();
  document.write(html);
  document.close();
}
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("TextEncoder", TextEncoder);
  vi.stubGlobal("TextDecoder", TextDecoder);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  history.replaceState(null, "", `/learn?generation=${GENERATION_ID}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser learning flow", () => {
  it("tests current unsaved model inputs with pending state and blocks duplicate/save requests", async () => {
    render(renderSettingsPage(pageContext, settingsModel()));
    let finish!: (value: ReturnType<typeof json>) => void;
    const fetch = vi.fn(
      () =>
        new Promise<ReturnType<typeof json>>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>(
      "[data-model-settings-form]",
    )!;
    const key = form.querySelector<HTMLInputElement>("[name='apiKey']")!;
    key.value = "unsaved-test-key";
    form.querySelector<HTMLSelectElement>("[name='provider']")!.value =
      "anthropic";
    form.querySelector<HTMLInputElement>("[name='model']")!.value =
      "unsaved-model";
    form.querySelector<HTMLInputElement>("[name='baseUrl']")!.value =
      "https://unsaved.example/anthropic";
    const button = form.querySelector<HTMLButtonElement>("[data-model-test]")!;
    button.click();
    button.click();
    submit(form);
    expect(button.disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(form.textContent).toContain("正在测试连接");
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0] as unknown as [
      string,
      { body: string; method: string },
    ];
    expect(call[0]).toBe("/api/settings/model/test");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({
      provider: "anthropic",
      model: "unsaved-model",
      baseUrl: "https://unsaved.example/anthropic",
      apiKey: "unsaved-test-key",
    });
    finish(
      json({
        ok: true,
        message: "连接成功。测试不会保存配置。",
        latencyMs: 42,
      }),
    );
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(form.textContent).toContain("42 ms");
    expect(form.textContent).toContain("测试不会保存配置");
    expect(key.value).toBe("unsaved-test-key");
    key.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form.textContent).toContain("配置已修改");
  });

  it("shows failed connection reasons and allows retrying with a saved key", async () => {
    render(renderSettingsPage(pageContext, settingsModel()));
    const fetch = vi.fn(async () =>
      json({ error: { message: "认证或权限校验失败（HTTP 401）" } }, false),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>(
      "[data-model-settings-form]",
    )!;
    form.querySelector<HTMLSelectElement>("[name='provider']")!.value =
      "anthropic";
    const button = form.querySelector<HTMLButtonElement>("[data-model-test]")!;
    form.dataset.apiKeyConfigured = "false";
    button.click();
    expect(fetch).not.toHaveBeenCalled();
    expect(form.textContent).toContain("请输入 API Key");
    form.dataset.apiKeyConfigured = "true";
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(form.textContent).toContain("HTTP 401");
    const call = fetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(call[1].body)).not.toHaveProperty("apiKey");
    button.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("submits the selected import ref to analysis and preserves the imported project on failure", async () => {
    render(renderProjectsPage(pageContext, projectsModel()));
    const fetch = vi.fn(async (url: string) =>
      url === "/api/projects"
        ? json({ projectId: "p_added", repoId: "r_added" })
        : json({ error: { message: "模型配额已用尽" } }, false),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>(
      "[data-project-kind='github']",
    )!;
    form.querySelector<HTMLInputElement>("[name='githubUrl']")!.value =
      "https://github.com/example/project";
    form.querySelector<HTMLInputElement>("[name='ref']")!.value = "release/v2";
    submit(form);
    await vi.waitFor(() =>
      expect(form.textContent).toContain("项目已添加。模型配额已用尽"),
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects",
      "/api/projects/p_added/analyses",
    ]);
    const analysisCall = fetch.mock.calls[1] as unknown as [
      string,
      { body: string },
    ];
    expect(JSON.parse(analysisCall[1].body)).toEqual({ ref: "release/v2" });
    expect(localStorage.getItem("codetrail:ref:p_added")).toBe("release/v2");
    expect(form.querySelector("a")?.getAttribute("href")).toBe(
      "/?project=p_added",
    );
  });
  it("saves a write-only model key and retains it on a subsequent blank-key edit", async () => {
    render(renderSettingsPage(pageContext, settingsModel()));
    const fetch = vi.fn(async () => json({ apiKeyConfigured: true }));
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>(
      "[data-model-settings-form]",
    )!;
    const key = form.querySelector<HTMLInputElement>("[name='apiKey']")!;
    const baseUrl = form.querySelector<HTMLInputElement>("[name='baseUrl']")!;
    baseUrl.value = "https://gateway.example/anthropic";
    key.value = "test-only-secret";
    submit(form);
    await vi.waitFor(() =>
      expect(
        form.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled,
      ).toBe(false),
    );
    expect(key.value).toBe("");
    expect(form.dataset.apiKeyConfigured).toBe("true");
    expect(form.textContent).toContain("对新任务立即生效");
    const firstCall = fetch.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(JSON.parse(firstCall[1].body)).toMatchObject({
      baseUrl: "https://gateway.example/anthropic",
    });
    baseUrl.value = "";
    submit(form);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const call = fetch.mock.calls[1] as unknown as [string, { body: string }];
    expect(JSON.parse(call[1].body)).not.toHaveProperty("apiKey");
    expect(JSON.parse(call[1].body)).toHaveProperty("baseUrl", null);
  });

  it("streams two questions into one persistent conversation without reloading", async () => {
    render(
      renderReaderPage(
        pageContext,
        readerModel({ conversation: null, readingPosition: null }),
      ),
    );
    const fetch = vi.fn(async (url: string) =>
      url === "/api/conversations"
        ? json({ conversationId: "c_browser" })
        : url.endsWith("/messages")
          ? stream([
              { type: "start", messageId: "m_answer" },
              { type: "delta", text: "中文回答" },
              {
                type: "done",
                status: "complete",
                messageId: "m_answer",
                incomplete: false,
              },
            ])
          : json({ generationIds: [GENERATION_ID], messages: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>("[data-qa-form]")!;
    const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "第一问";
    submit(form);
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(
      document.querySelector("[data-testid=qa-stream]")?.textContent,
    ).toContain("中文回答");
    expect(form.dataset.conversationId).toBe("c_browser");
    expect(location.search).toContain("conversation=c_browser");
    input.value = "接着上一个问题";
    submit(form);
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(
      fetch.mock.calls.filter(([url]) => url === "/api/conversations"),
    ).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("/messages")),
    ).toHaveLength(2);
    expect(
      localStorage.getItem(`codetrail:conversation:${GENERATION_ID}`),
    ).toBe("c_browser");
    expect(
      Array.from(
        document.querySelectorAll<HTMLAnchorElement>(".lesson-nav a"),
      ).every((link) => link.href.includes("conversation=c_browser")),
    ).toBe(true);
  });
  it("keeps the draft and exposes SSE business errors even when HTTP is 200", async () => {
    render(
      renderReaderPage(
        pageContext,
        readerModel({ conversation: null, readingPosition: null }),
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/conversations"
          ? json({ conversationId: "c_error" })
          : url.endsWith("/messages")
            ? stream([
                {
                  type: "error",
                  code: "budget_exhausted",
                  message: "模型配额已用尽",
                },
              ])
            : json({ messages: [] }),
      ),
    );
    await import("../../../src/learning/ui/client.ts");
    const form = document.querySelector<HTMLFormElement>("[data-qa-form]")!;
    const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "不要丢失这个问题";
    submit(form);
    await vi.waitFor(() =>
      expect(form.querySelector("[data-form-status]")?.textContent).toContain(
        "配额已用尽",
      ),
    );
    expect(input.value).toBe("不要丢失这个问题");
    await vi.waitFor(() =>
      expect(
        form.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled,
      ).toBe(false),
    );
  });
  it("opens escaped source content in place and binds the code to a follow-up", async () => {
    render(
      renderReaderPage(
        pageContext,
        readerModel({ conversation: null, readingPosition: null }),
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          label: "src/example.ts:2–3",
          content: "<script>unsafe()</script>",
          commitSha: "a".repeat(40),
          lines: { start: 2, end: 3 },
          availability: "available",
        }),
      ),
    );
    await import("../../../src/learning/ui/client.ts");
    document.querySelector<HTMLAnchorElement>("a[data-source-link]")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-source-content]")?.textContent).toBe(
        "<script>unsafe()</script>",
      ),
    );
    expect(document.querySelector("[data-source-content] script")).toBeNull();
    expect(location.search).toContain("source=");
    document.querySelector<HTMLButtonElement>("[data-source-ask]")!.click();
    expect(
      document.querySelector<HTMLInputElement>("[data-qa-selection-source]")
        ?.value,
    ).not.toBe("");
    expect(
      document.querySelector<HTMLInputElement>("[data-qa-selection-commit]")
        ?.value,
    ).toBe("a".repeat(40));
    expect(
      document.querySelector<HTMLElement>(".reader-grid")?.dataset.readerPanel,
    ).toBe("qa");
  });
  it("refuses removal until the selected project's dependencies and confirmation are present", async () => {
    render(renderProjectsPage(pageContext, projectsModel()));
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    const fetch = vi.fn(async () => json({ conversations: { count: 2 } }));
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    document.querySelector<HTMLButtonElement>("[data-select-project]")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".dependent-list")?.textContent).toContain(
        "会话：2",
      ),
    );
    const form = document.querySelector<HTMLFormElement>(
      "[data-remove-project]",
    )!;
    expect(form.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
      true,
    );
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fetch.mock.calls.every(([url]) => !String(url).includes("confirm=true")),
    ).toBe(true);
    const check = form.querySelector<HTMLInputElement>("input")!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    expect(form.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
      false,
    );
  });
});
