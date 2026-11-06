/**
 * Bilingual glossary (architecture §15, AC-UI-07).
 *
 * Each term carries its Chinese and English names and one link per generation
 * where it appeared. The cross-project link points at that generation's source,
 * never at "the latest version" of the project.
 */

import type { TermView, TermsPageModel } from "../../contracts/index.js";
import { escapeAttribute, escapeHtml } from "../render/markdown.js";
import { renderPageShell } from "./layout.js";
import type { PageContext } from "./layout.js";

export type { PageContext } from "./layout.js";

function symbols(term: TermView): string {
  if (term.symbols.length === 0) return "";
  return ` <span class="symbols">（${escapeHtml(term.symbols.join("、"))}）</span>`;
}

/** Renders `GET /terms`. */
export function renderTermsPage(
  ctx: PageContext,
  model: TermsPageModel,
): string {
  const terms = model.terms ?? [];
  const rows = terms
    .map(
      (term) =>
        `<tr data-term-id="${escapeAttribute(term.termId)}"><td><strong>${escapeHtml(term.zh)}</strong></td><td>${escapeHtml(term.en)}${symbols(term)}</td><td>${term.links.map((link) => `<a class="term-source" data-generation-id="${escapeAttribute(link.generationId)}" data-project-id="${escapeAttribute(link.projectId)}" data-source-id="${escapeAttribute(link.sourceId)}" href="/learn/reader?generation=${escapeAttribute(link.generationId)}&source=${escapeAttribute(link.sourceId)}">查看代码来源</a>`).join("") || '<span class="empty">尚无跨项目来源。</span>'}</td></tr>`,
    )
    .join("");
  const body = `<header class="page-head"><div><span class="eyebrow">把概念连接到代码</span><h1>术语</h1><p>中英文名称、代码符号和固定版本的来源放在一起。</p></div></header><label class="terms-filter">查找术语<input data-term-filter type="search" placeholder="中文、英文或代码符号"></label><section class="panel"><table class="terms-table"><thead><tr><th data-testid="term-zh" scope="col">中文名</th><th data-testid="term-en" scope="col">英文与代码符号</th><th data-testid="term-cross-project" scope="col">代码来源</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">尚无术语。生成项目讲解后会在此汇集。</td></tr>'}</tbody></table><p data-term-empty hidden>没有匹配的术语。</p></section>`;

  return renderPageShell(ctx, "术语", "terms", body);
}
