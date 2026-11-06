// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- browser API doubles */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { lessonTitle } from "../../../src/learning/lessons/title.ts";
import {
  GENERATION_ID,
  LESSON_ID,
  pageContext,
  readerModel,
} from "./fixtures.ts";

beforeEach(() => {
  vi.resetModules();
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
  history.replaceState(null, "", `/learn/reader?generation=${GENERATION_ID}`);
  document.open();
  document.write(
    renderReaderPage(pageContext, readerModel({ readingPosition: null })),
  );
  document.close();
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("learning explanation and lesson management", () => {
  it("explains automatic lessons versus question answers, and folds the module inventory", () => {
    expect(document.body.textContent).toContain("项目讲解由分析自动生成");
    expect(document.body.textContent).toContain(
      "每个主题有独立讲解和追问记录",
    );
    const summary = [...document.querySelectorAll("summary")].find((el) =>
      el.textContent?.includes("项目模块目录"),
    );
    expect((summary?.parentElement as HTMLDetailsElement).open).toBe(false);
  });

  it("requires the confirmation action, supports cancellation, and keeps a failed deletion reviewable", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: "测试：删除失败" } }),
    }));
    vi.stubGlobal("fetch", fetch);
    await import("../../../src/learning/ui/client.ts");
    const dialog = document.querySelector<HTMLDialogElement>("#delete-lesson")!;
    document
      .querySelector<HTMLButtonElement>("[data-open-dialog='delete-lesson']")!
      .click();
    expect(dialog.open).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    dialog.querySelector<HTMLButtonElement>("[data-close-dialog]")!.click();
    expect(dialog.open).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    document
      .querySelector<HTMLButtonElement>("[data-open-dialog='delete-lesson']")!
      .click();
    const button = dialog.querySelector<HTMLButtonElement>(
      "button[type='submit']",
    )!;
    button.click();
    button.click();
    await vi.waitFor(() =>
      expect(dialog.textContent).toContain("测试：删除失败"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      `/api/generations/${GENERATION_ID}/lessons/${LESSON_ID}?confirm=true`,
      { method: "DELETE" },
    ]);
    expect(dialog.open).toBe(true);
  });

  it("shows recovery and direct project questions when the last lesson was deleted", () => {
    document.body.innerHTML = renderReaderPage(
      pageContext,
      readerModel({
        lessons: [],
        activeLesson: null,
        deletedLessons: [
          {
            lessonId: LESSON_ID,
            title: "已删除的讲解",
            kind: "research",
            moduleIds: [],
            hasCoverageGaps: false,
          },
        ],
        readingPosition: null,
      }),
    );
    expect(document.body.textContent).toContain("本版本的讲解已删除");
    expect(
      document
        .querySelector("[data-restore-lesson]")
        ?.getAttribute("data-restore-lesson"),
    ).toBe(LESSON_ID);
    expect(
      document.querySelector<HTMLButtonElement>(
        "[data-qa-form] button[type='submit']",
      )?.disabled,
    ).toBe(false);
  });

  it("replaces old scenario IDs with a readable title while preserving an existing authored title", () => {
    expect(
      lessonTitle("sc_abcdef012345", "research", {
        technicalExplanation: [{ terms: [{ zh: "共形校准" }] }],
      }),
    ).toBe("项目讲解：共形校准");
    expect(lessonTitle("已有标题", "research")).toBe("已有标题");
  });
});
