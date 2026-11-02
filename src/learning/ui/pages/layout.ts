/**
 * Shared page chrome for the server-rendered learning UI (architecture §15).
 *
 * Every page is a plain HTML string with the same shell: one stylesheet and one
 * deferred module script, both same-origin, and no inline script. Navigation
 * links are root-relative so the CSP `default-src 'none'` policy can only ever
 * reach this listener.
 */

import { escapeAttribute, escapeHtml } from "../render/markdown.js";

export interface PageContext {
  dataRoot: string;
  assetBase: string;
}

/**
 * The one sentence the reader, inbox and settings pages must repeat: polling
 * cannot promise to capture every head overwritten by a force-push between two
 * polls (AC-UPD-26, AC-UI-11).
 */
export const POLLING_NOTE =
  "轮询只能看到每次轮询时的默认分支与 PR 元数据；两次轮询之间被 force-push " +
  "覆盖的中间 head 无法保证被捕获，也不会假装恢复。" +
  "应用关闭时不轮询，启动后从已发现的游标补齐。";

export const UI_NAV = [
  { href: "/", label: "项目", key: "projects" },
  { href: "/learn", label: "学习", key: "learn" },
  { href: "/inbox", label: "更新收件箱", key: "inbox" },
  { href: "/terms", label: "术语", key: "terms" },
  { href: "/settings", label: "设置", key: "settings" },
] as const;

/** A same-origin asset prefix; anything else falls back to `/assets`. */
export function safeAssetBase(value: string | undefined): string {
  if (value === undefined) return "/assets";
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed === "" || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/assets";
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return "/assets";
  return trimmed;
}

/** A stable, human-readable placeholder for a missing timestamp. */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return escapeHtml(value);
}

/** The short form used in cards and badges. */
export function shortSha(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return escapeHtml(value.slice(0, 12));
}

const JOB_STATE_LABEL: Readonly<Record<string, string>> = {
  queued: "排队中",
  running: "运行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function jobStateLabel(state: string | null | undefined): string {
  if (state === null || state === undefined || state === "") return "—";
  return JOB_STATE_LABEL[state] ?? state;
}

/** A collapsed block; `data-collapsed="true"` is the AC-UI-03 contract. */
export function collapsedDetails(
  summary: string,
  body: string,
  block: string,
): string {
  return (
    `<details data-collapsed="true" data-block="${escapeAttribute(block)}">` +
    `<summary>${escapeHtml(summary)}</summary>${body}</details>`
  );
}

function nav(active: string): string {
  const links = UI_NAV.map((item) => {
    const current = item.key === active ? ' aria-current="page"' : "";
    return `<a href="${item.href}"${current}>${escapeHtml(item.label)}</a>`;
  }).join("");
  return `<nav class="site-nav" aria-label="主导航">${links}</nav>`;
}

/**
 * The document shell. `assetBase` is normalised so a caller can never inject a
 * CDN or a protocol-relative origin into a page.
 */
export function renderPageShell(
  ctx: PageContext,
  title: string,
  active: string,
  body: string,
): string {
  const assetBase = safeAssetBase(ctx.assetBase);
  return (
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)} · Codetrail</title>` +
    `<link rel="stylesheet" href="${escapeAttribute(`${assetBase}/styles.css`)}">` +
    `<script src="${escapeAttribute(`${assetBase}/client.js`)}" defer></script>` +
    `</head><body data-page="${escapeAttribute(active)}">` +
    `<header class="site-header">` +
    `<a class="brand" href="/">Codetrail</a>${nav(active)}` +
    `</header>` +
    `<main class="page">${body}</main>` +
    `</body></html>`
  );
}

/** Escapes an id for a `data-*` attribute. */
export function attr(value: string | null | undefined): string {
  return escapeAttribute(value ?? "");
}
