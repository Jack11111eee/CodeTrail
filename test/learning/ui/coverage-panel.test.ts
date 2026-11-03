import { describe, expect, it } from "vitest";

import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { coverage, pageContext, readerModel } from "./fixtures.ts";

/** AC-UI-05: coverage gaps are explicit and completeness is never claimed. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("coverage panel", () => {
  it("lists every unanalysed path with its reason", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({
        coverage: coverage({
          complete: false,
          gaps: [
            {
              path: "node_modules/pkg/index.js",
              reason: "excluded_default_dir",
              bytes: 10,
            },
            {
              path: "assets/logo.png",
              reason: "excluded_binary",
              bytes: 20,
              detail: "binary",
            },
          ],
          counts: { totalFiles: 3, analyzedFiles: 1, excludedFiles: 2 },
        }),
      }),
    );

    expect(countTestId(html, "coverage-gaps")).toBe(1);
    expect(html).toContain('data-path="node_modules/pkg/index.js"');
    expect(html).toContain("默认排除目录");
    expect(html).toContain('data-path="assets/logo.png"');
    expect(html).toContain("二进制文件");
    expect(html).toContain("覆盖不完整");
    expect(html).toContain("绝不声称完整");
    expect(html).toContain('data-complete="false"');
  });

  it("does not claim completeness for a partial report", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({
        coverage: coverage({
          complete: false,
          gaps: [
            { path: "vendor/lib.go", reason: "excluded_by_scope", bytes: 1 },
          ],
        }),
      }),
    );
    expect(html).not.toContain("覆盖报告：未记录未分析路径");
    expect(html).toContain("覆盖不完整");
  });

  it("never trusts a complete flag that contradicts its own gap list", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({
        coverage: coverage({
          complete: true,
          gaps: [
            { path: "vendor/lib.go", reason: "excluded_by_scope", bytes: 1 },
          ],
        }),
      }),
    );
    expect(html).toContain('data-path="vendor/lib.go"');
    expect(html).not.toContain("覆盖报告：未记录未分析路径");
    expect(html).toContain("覆盖不完整");
    expect(html).toContain('data-complete="false"');
  });

  it("renders a complete report without inventing gaps", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({ coverage: coverage({ complete: true, gaps: [] }) }),
    );
    expect(html).toContain('data-complete="true"');
    expect(html).toContain("未记录未分析路径");
    expect(html).toContain("已分析 1 / 1 个文件");
  });

  it("handles a missing coverage report without claiming analysis", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({ coverage: null as never }),
    );
    expect(html).toContain("覆盖信息不可用");
    expect(html).toContain('data-complete="false"');
  });
});
