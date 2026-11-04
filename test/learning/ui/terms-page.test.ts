import { describe, expect, it } from "vitest";

import { renderTermsPage } from "../../../src/learning/ui/pages/terms.ts";
import {
  GENERATION_ID,
  pageContext,
  SOURCE_ID,
  termsModel,
  termView,
} from "./fixtures.ts";

/** AC-UI-07: bilingual names and generation-specific cross-project links. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("terms page", () => {
  it("renders zh, en and cross-project exactly once", () => {
    const html = renderTermsPage(pageContext, termsModel());
    for (const testid of ["term-zh", "term-en", "term-cross-project"]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
    expect(html).toContain("快照");
    expect(html).toContain("snapshot");
    expect(html).toContain("SnapshotRecord");
  });

  it("links to that generation's source, not the latest version", () => {
    const html = renderTermsPage(pageContext, termsModel());
    expect(html).toContain(`/learn/reader?generation=${GENERATION_ID}`);
    expect(html).toContain(`&source=${SOURCE_ID}`);
    expect(html).toContain(`data-generation-id="${GENERATION_ID}"`);
    expect(html).toContain(`data-source-id="${SOURCE_ID}"`);
    expect(html).toContain(`data-project-id="p_0123456789abcdef"`);
  });

  it("renders every term across projects", () => {
    const html = renderTermsPage(
      pageContext,
      termsModel({
        terms: [
          termView(),
          termView({
            termId: "t_second" as never,
            zh: "清单",
            en: "manifest",
            symbols: [],
            links: [
              {
                generationId: "g_second" as never,
                repoId: "r_second" as never,
                projectId: "p_second" as never,
                sourceId: "s_second" as never,
              },
            ],
          }),
        ],
      }),
    );
    expect(html).toContain("快照");
    expect(html).toContain("清单");
    expect(html).toContain("manifest");
    expect(html).toContain("g_second");
    expect(html).toContain("s_second");
    for (const testid of ["term-zh", "term-en", "term-cross-project"]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
  });

  it("renders an empty glossary without losing the testids", () => {
    const html = renderTermsPage(pageContext, termsModel({ terms: [] }));
    expect(html).toContain("尚无术语");
    for (const testid of ["term-zh", "term-en", "term-cross-project"]) {
      expect(countTestId(html, testid), testid).toBe(1);
    }
  });

  it("renders an empty cross-project list for a term without links", () => {
    const html = renderTermsPage(
      pageContext,
      termsModel({ terms: [termView({ links: [] })] }),
    );
    expect(html).toContain("尚无跨项目来源");
    expect(html).toContain("快照");
    expect(countTestId(html, "term-cross-project")).toBe(1);
  });
});
