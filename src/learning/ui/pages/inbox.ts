/**
 * Update inbox (architecture §15, AC-UI-06, AC-UPD-26).
 *
 * One row per discovered change event: its state, significance, a gap badge and
 * an expandable original commit. The page never links to GitHub — the commit is
 * shown as a short record only, and no comment/write action exists.
 */

import type { ChangeSummary, InboxPageModel } from "../../contracts/index.js";
import { escapeAttribute, escapeHtml } from "../render/markdown.js";
import { renderPageShell } from "./layout.js";
import type { PageContext } from "./layout.js";

export type { PageContext } from "./layout.js";

const STATE_TEXT: Readonly<Record<string, string>> = {
  discovered: "已发现",
  queued: "排队中",
  analyzing: "分析中",
  published: "已发布",
  failed: "失败",
  waiting: "等待中",
  cancelled: "已取消",
  gap: "缺口",
};

const KIND_TEXT: Readonly<Record<string, string>> = {
  baseline: "基线",
  commit: "提交",
  merge_commit: "合并提交",
  pull_request: "Pull Request",
  history_gap: "历史缺口",
  branch_switch: "分支切换",
  comparison: "对比",
};

function itemMarkup(item: ChangeSummary): string {
  const short = item.significance === "short";
  const gapFlag = item.hasGap
    ? `<span class="gap-flag" data-gap="true">缺口</span>`
    : "";
  const commit =
    short || (item.headSha === null && item.baseSha === null)
      ? ""
      : `<details data-collapsed="true"><summary>原提交</summary>` +
        `<dl class="commit-record">` +
        `<dt>head</dt><dd><code>${escapeHtml(item.headSha ?? "—")}</code></dd>` +
        `<dt>base</dt><dd><code>${escapeHtml(item.baseSha ?? "—")}</code></dd>` +
        `<dt>发现时间</dt><dd>${escapeHtml(item.discoveredAt)}</dd>` +
        `<dt>发布时间</dt><dd>${escapeHtml(item.publishedAt ?? "—")}</dd>` +
        `</dl></details>`;

  return (
    `<li class="inbox-item${short ? " short" : ""}" data-testid="inbox-item" ` +
    `data-change-id="${escapeAttribute(item.changeId)}" ` +
    `data-state="${escapeAttribute(item.state)}" ` +
    `data-kind="${escapeAttribute(item.kind)}" ` +
    `data-significance="${escapeAttribute(item.significance)}">` +
    `<header class="item-head">` +
    `<h2>${escapeHtml(item.title)}</h2>` +
    `<span class="state">${escapeHtml(STATE_TEXT[item.state] ?? item.state)}</span>` +
    gapFlag +
    `</header>` +
    `<p class="item-meta">${escapeHtml(KIND_TEXT[item.kind] ?? item.kind)} · ` +
    `${escapeHtml(item.streamKind)} · ` +
    `${short ? "短记录" : "完整记录"}</p>` +
    commit +
    (item.generationId
      ? `<a class="button" href="/learn/reader?generation=${escapeAttribute(item.generationId)}">阅读变更讲解 →</a>`
      : `<p class="hint">${item.state === "queued" || item.state === "analyzing" ? "讲解生成后可在此阅读。" : "暂无可阅读的讲解。"}</p>`) +
    `</li>`
  );
}

/** Renders `GET /inbox`. */
export function renderInboxPage(
  ctx: PageContext,
  model: InboxPageModel,
): string {
  const items = model.items ?? [];
  const gapCount = items.filter((item) => item.hasGap).length;
  const list =
    items.length === 0
      ? `<li class="empty">尚无更新记录。</li>`
      : items.map(itemMarkup).join("");
  const next =
    model.next === null
      ? ""
      : `<p class="pagination"><a href="/inbox?project=${escapeAttribute(
          model.projectId,
        )}&cursor=${escapeAttribute(model.next)}">下一页</a></p>`;

  const body =
    `<header class="page-head"><h1>更新收件箱</h1>` +
    `<p>${escapeHtml(model.projectName ?? "当前项目")}的行为变化与代码依据</p>${model.projects && model.projects.length > 1 ? `<label>切换项目<select data-project-switch>${model.projects.map((project) => `<option value="${escapeAttribute(project.projectId)}"${project.projectId === model.projectId ? " selected" : ""}>${escapeHtml(project.displayName)}</option>`).join("")}</select></label>` : ""}</header>` +
    `<details class="product-note"><summary>跟进范围与轮询限制</summary><p class="polling-note" data-testid="polling-note">${escapeHtml(model.pollingNote)}</p></details>` +
    `<p class="gap-summary"><span class="gap-badge" data-testid="inbox-gap-badge" ` +
    `data-gap-count="${String(gapCount)}">缺口 ${String(gapCount)}</span></p>` +
    `<ul class="inbox-list" data-testid="inbox-list">${list}</ul>` +
    next;

  return renderPageShell(
    { ...ctx, projectId: model.projectId },
    "更新收件箱",
    "inbox",
    body,
  );
}
