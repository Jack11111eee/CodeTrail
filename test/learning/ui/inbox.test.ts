import { describe, expect, it } from "vitest";

import { renderInboxPage } from "../../../src/learning/ui/pages/inbox.ts";
import {
  changeSummary,
  HEAD_SHA,
  inboxModel,
  pageContext,
} from "./fixtures.ts";

/** AC-UI-06: events, state, gap badge, expandable commit, short records. */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

describe("update inbox", () => {
  it("renders the list, items and one gap badge", () => {
    const html = renderInboxPage(
      pageContext,
      inboxModel({
        items: [
          changeSummary({ state: "published" }),
          changeSummary({
            changeId: "e_second" as never,
            state: "gap",
            kind: "history_gap",
            hasGap: true,
            title: "历史缺口",
          }),
        ],
      }),
    );

    expect(countTestId(html, "inbox-list")).toBe(1);
    expect(countTestId(html, "inbox-item")).toBe(2);
    expect(countTestId(html, "inbox-gap-badge")).toBe(1);
    expect(html).toContain('data-gap-count="1"');
    expect(html).toContain("缺口 1");
    expect(html).toContain("已发布");
    expect(html).toContain("历史缺口");
  });

  it("expands the original commit and never links to GitHub", () => {
    const html = renderInboxPage(pageContext, inboxModel());
    expect(html).toContain('<details data-collapsed="true">');
    expect(html).toContain("原提交");
    expect(html).toContain(HEAD_SHA.slice(0, 12));
    expect(html).not.toContain("github.com");
    expect(html).not.toContain("comment");
    expect(html).not.toContain("/issues/");
  });

  it("renders a short record as a brief entry", () => {
    const html = renderInboxPage(
      pageContext,
      inboxModel({
        items: [changeSummary({ significance: "short", state: "discovered" })],
      }),
    );
    expect(html).toContain('data-significance="short"');
    expect(html).toContain("短记录");
    expect(html).not.toContain("原提交");
  });

  it("renders the next pagination cursor", () => {
    const html = renderInboxPage(
      pageContext,
      inboxModel({ next: "cursor-token" }),
    );
    expect(html).toContain("下一页");
    expect(html).toContain("cursor=cursor-token");
  });

  it("states the force-push polling limit on the inbox", () => {
    const html = renderInboxPage(pageContext, inboxModel());
    expect(countTestId(html, "polling-note")).toBe(1);
    expect(html).toContain("force-push");
    expect(html).toContain("无法保证");
  });

  it("renders an empty inbox with a zero gap badge", () => {
    const html = renderInboxPage(
      pageContext,
      inboxModel({ items: [], next: null }),
    );
    expect(html).toContain("尚无更新记录");
    expect(html).toContain('data-gap-count="0"');
    expect(countTestId(html, "inbox-list")).toBe(1);
  });

  it("omits the commit details when no sha was recorded", () => {
    const html = renderInboxPage(
      pageContext,
      inboxModel({
        items: [changeSummary({ headSha: null, baseSha: null })],
      }),
    );
    expect(html).not.toContain("原提交");
    expect(html).toContain("完整记录");
    expect(countTestId(html, "inbox-item")).toBe(1);
  });

  it("counts every gap in the badge", () => {
    const html = renderInboxPage(
      pageContext,
      inboxModel({
        items: [
          changeSummary({ hasGap: true, state: "gap" }),
          changeSummary({
            changeId: "e_second" as never,
            hasGap: true,
            state: "gap",
          }),
          changeSummary({ changeId: "e_third" as never, hasGap: false }),
        ],
      }),
    );
    expect(html).toContain('data-gap-count="2"');
    expect(html).toContain("缺口 2");
  });
});
