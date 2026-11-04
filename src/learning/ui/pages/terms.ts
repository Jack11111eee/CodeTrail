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

function zhList(terms: TermView[]): string {
  if (terms.length === 0) return `<li class="empty">尚无术语。</li>`;
  return terms
    .map(
      (term) =>
        `<li data-term-id="${escapeAttribute(term.termId)}">` +
        `${escapeHtml(term.zh)}${symbols(term)}</li>`,
    )
    .join("");
}

function enList(terms: TermView[]): string {
  if (terms.length === 0) return `<li class="empty">尚无术语。</li>`;
  return terms
    .map(
      (term) =>
        `<li data-term-id="${escapeAttribute(term.termId)}">` +
        `${escapeHtml(term.en)}</li>`,
    )
    .join("");
}

function crossProjectLinks(terms: TermView[]): string {
  const links = terms.flatMap((term) =>
    term.links.map((link) => {
      const href =
        `/learn/reader?generation=${escapeAttribute(link.generationId)}` +
        `&source=${escapeAttribute(link.sourceId)}`;
      return (
        `<li data-term-id="${escapeAttribute(term.termId)}" ` +
        `data-generation-id="${escapeAttribute(link.generationId)}" ` +
        `data-project-id="${escapeAttribute(link.projectId)}" ` +
        `data-source-id="${escapeAttribute(link.sourceId)}">` +
        `<span class="term-name">${escapeHtml(term.zh)}</span> ` +
        `<a href="${href}">${escapeHtml(link.generationId)} · ` +
        `${escapeHtml(link.sourceId)}</a></li>`
      );
    }),
  );
  if (links.length === 0) return `<li class="empty">尚无跨项目来源。</li>`;
  return links.join("");
}

/** Renders `GET /terms`. */
export function renderTermsPage(
  ctx: PageContext,
  model: TermsPageModel,
): string {
  const terms = model.terms ?? [];
  const body =
    `<header class="page-head"><h1>术语</h1>` +
    `<p>中英名称与跨项目来源；链接指向该生成版本中的具体来源。</p></header>` +
    `<div class="terms-grid">` +
    `<section class="panel" data-testid="term-zh"><h2>中文名</h2>` +
    `<ul>${zhList(terms)}</ul></section>` +
    `<section class="panel" data-testid="term-en"><h2>英文名</h2>` +
    `<ul>${enList(terms)}</ul></section>` +
    `<section class="panel" data-testid="term-cross-project"><h2>跨项目来源</h2>` +
    `<ul>${crossProjectLinks(terms)}</ul></section>` +
    `</div>`;

  return renderPageShell(ctx, "术语", "terms", body);
}
