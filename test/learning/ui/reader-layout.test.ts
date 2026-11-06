import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { pageContext, readerModel } from "./fixtures.ts";

/** AC-UI-02: the three reader regions and the narrow-screen rule. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

const stylesheet = fs.readFileSync(
  path.resolve("src/learning/ui/styles.css"),
  "utf8",
);

describe("reader layout", () => {
  it("renders nav, lesson and QA exactly once", () => {
    const html = renderReaderPage(pageContext, readerModel());
    for (const testid of ["reader-nav", "reader-lesson", "reader-qa"]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
    expect(html).toContain('class="reader-grid"');
  });

  it("keeps the QA surface inside the reader", () => {
    const html = renderReaderPage(pageContext, readerModel());
    for (const testid of ["qa-input", "qa-stream", "qa-citations"]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
    expect(html).toContain("你的问题");
    expect(html).toContain("回答：slugify 先 trim。");
  });

  it("keeps reading wide and opens a context column only on demand", () => {
    expect(stylesheet).toMatch(
      /grid-template-columns:\s*180px minmax\(0,\s*1fr\)/u,
    );
    expect(stylesheet).toMatch(
      /\.reader-grid\[data-reader-panel=["']?qa["']?\]/u,
    );
    expect(stylesheet).toMatch(
      /\.reader-grid\[data-reader-panel=["']?source["']?\]/u,
    );
  });

  it("literally names all three reader regions in the 900px query", () => {
    expect(stylesheet).toContain("@media (max-width: 900px)");
    expect(stylesheet).toMatch(
      /\[data-testid="reader-nav"\],\s*\[data-testid="reader-lesson"\],\s*\[data-testid="reader-qa"\]/u,
    );
    const start = stylesheet.indexOf("@media (max-width: 900px)");
    const block = stylesheet.slice(start, stylesheet.indexOf("}", start) + 1);
    expect(block).toContain('[data-testid="reader-nav"]');
    expect(block).toContain('[data-testid="reader-lesson"]');
    expect(block).toContain('[data-testid="reader-qa"]');
  });

  it("states the force-push polling limit on the reader", () => {
    const html = renderReaderPage(pageContext, readerModel());
    expect(countTestId(html, "polling-note")).toBe(1);
    expect(html).toContain("force-push");
    expect(html).toContain("无法保证");
  });

  it("renders an empty reader when there is no active lesson", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({ activeLesson: null, lessons: [] }),
    );
    expect(html).toContain("尚无讲解");
    expect(html).toContain("选择一个讲解");
    for (const testid of ["reader-nav", "reader-lesson", "reader-qa"]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
  });

  it("renders the QA panel without a conversation or reading position", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({ conversation: null, readingPosition: null }),
    );
    expect(html).toContain("尚无追问");
    expect(html).toContain("尚无引用");
    expect(html).toContain("尚无阅读位置");
    expect(html).toContain('action="/api/conversations"');
    expect(countTestId(html, "qa-input")).toBe(1);
  });
});
