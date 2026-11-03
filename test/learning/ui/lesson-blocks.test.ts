import { describe, expect, it } from "vitest";

import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import {
  lessonDetail,
  pageContext,
  readerModel,
  researchLesson,
} from "./fixtures.ts";

/** AC-UI-03: one expanded scenario, four collapsed blocks. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("lesson blocks", () => {
  it("renders the five required lesson blocks exactly once", () => {
    const html = renderReaderPage(pageContext, readerModel());
    for (const testid of [
      "lesson-plain",
      "lesson-technical",
      "lesson-choices",
      "lesson-boundaries",
      "lesson-evidence",
    ]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
  });

  it("expands one scenario and the key concepts by default", () => {
    const html = renderReaderPage(pageContext, readerModel());
    expect(html).toContain('data-expanded="true"');
    expect(html).toContain("调用公开接口");
    expect(html).toContain("把标签转换成 URL 安全的 slug");
    expect(html).toContain("先去空格，再统一小写。");
    expect(html).not.toContain('<details data-collapsed="false"');
  });

  it("collapses code, deep mechanics, alternatives and prerequisites", () => {
    const html = renderReaderPage(pageContext, readerModel());
    for (const block of [
      "code",
      "deep-mechanics",
      "alternatives",
      "prerequisites",
    ]) {
      expect(html, block).toContain(
        `<details data-collapsed="true" data-block="${block}">`,
      );
    }
    expect(html).toContain("深入原理");
    expect(html).toContain("原始代码");
    expect(html).toContain("替代方案");
    expect(html).toContain("前置基础");
    expect(html).toContain("用正则把非字母数字字符折叠成连字符。");
    expect(html).toContain("手写循环");
    expect(html).toContain("只处理 ASCII");
  });

  it("keeps evidence statements labelled and linked", () => {
    const html = renderReaderPage(pageContext, readerModel());
    expect(html).toContain("代码事实");
    expect(html).toContain("slugify 会先 trim 再小写。");
    expect(html).toContain("s_0123456789abcdef");
  });

  it("renders empty blocks for a lesson without content", () => {
    const lesson = researchLesson({
      plainExplanation: [],
      technicalExplanation: [],
      choices: [],
      boundaries: [],
      statements: [],
      evidence: [],
    });
    const html = renderReaderPage(
      pageContext,
      readerModel({
        activeLesson: lessonDetail("component", { lesson }),
      }),
    );
    expect(html).toContain("通俗解释暂无内容");
    expect(html).toContain("边界暂无内容");
    for (const testid of [
      "lesson-plain",
      "lesson-technical",
      "lesson-choices",
      "lesson-boundaries",
      "lesson-evidence",
    ]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
  });

  it("states why choices were omitted and still collapses alternatives", () => {
    const lesson = researchLesson({
      choices: [],
      choicesOmittedReason: "该模块没有可对比的替代方案",
    });
    const html = renderReaderPage(
      pageContext,
      readerModel({
        activeLesson: lessonDetail("component", { lesson }),
      }),
    );
    expect(html).toContain("该模块没有可对比的替代方案");
    expect(html).toContain(
      '<details data-collapsed="true" data-block="alternatives">',
    );
    expect(countTestId(html, "lesson-choices")).toBe(1);
  });
});
