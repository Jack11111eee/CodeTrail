/**
 * Settings page (architecture §15, AC-UI-08/09/10/11, AC-UPD-26).
 *
 * Four independent concerns share the page but never share an input:
 * explanation preference, self-described background, reading position and the
 * deployment model. There is deliberately no mastery/score/proficiency field.
 */

import type {
  SettingsPageModel,
  UsageKind,
  UsageView,
} from "../../contracts/index.js";
import { escapeAttribute, escapeHtml } from "../render/markdown.js";
import { formatTimestamp, renderPageShell } from "./layout.js";
import type { PageContext } from "./layout.js";

export type { PageContext } from "./layout.js";

const USAGE_KINDS: readonly UsageKind[] = Object.freeze([
  "initial",
  "update",
  "comparison",
  "qa",
  "change",
]);

const USAGE_LABEL: Readonly<Record<UsageKind, string>> = {
  initial: "初次分析",
  update: "更新分析",
  comparison: "对比",
  qa: "追问",
  change: "变更",
};

function groupOf(
  usage: UsageView,
  kind: UsageKind,
): UsageView["groups"][number] {
  return (
    usage.groups.find((group) => group.kind === kind) ?? {
      kind,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      costCents: null,
    }
  );
}

function costCell(
  costCents: number | null,
  pricingConfigured: boolean,
): string {
  if (!pricingConfigured) return "仅用量";
  if (costCents === null) return "—";
  return `${String(costCents)} 分`;
}

function usageRows(usage: UsageView): string {
  const kinds = [
    ...USAGE_KINDS,
    ...usage.groups
      .map((group) => group.kind)
      .filter((kind) => !USAGE_KINDS.includes(kind)),
  ];
  return kinds
    .map((kind) => {
      const group = groupOf(usage, kind);
      return (
        `<tr data-kind="${escapeAttribute(kind)}">` +
        `<th scope="row">${escapeHtml(USAGE_LABEL[kind] ?? kind)}</th>` +
        `<td>${String(group.inputTokens)}</td>` +
        `<td>${String(group.outputTokens)}</td>` +
        `<td>${String(group.calls)}</td>` +
        `<td>${escapeHtml(
          costCell(group.costCents, usage.totals.pricingConfigured),
        )}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function modelScope(model: SettingsPageModel): string {
  const dataSent =
    model.model.dataSent.length === 0
      ? `<li class="empty">尚未配置发送范围。</li>`
      : model.model.dataSent
          .map((entry) => `<li>${escapeHtml(entry)}</li>`)
          .join("");
  return (
    `<section class="panel" data-testid="settings-model-scope" ` +
    `data-pricing-configured="${model.model.pricingConfigured ? "true" : "false"}">` +
    `<h2>模型与发送范围</h2>` +
    `<p>provider：<code>${escapeHtml(model.model.provider || "未配置")}</code></p>` +
    `<p>model：<code>${escapeHtml(model.model.model || "未配置")}</code></p>` +
    `<p>价格：${model.model.pricingConfigured ? "已配置" : "未配置（仅显示用量）"}</p>` +
    `<h3>发送给模型的内容范围</h3>` +
    `<ul class="data-sent">${dataSent}</ul>` +
    `</section>`
  );
}

function usagePanel(model: SettingsPageModel): string {
  const usage = model.usage;
  const totals = usage.totals;
  return (
    `<section class="panel" data-testid="settings-usage" ` +
    `data-pricing-configured="${totals.pricingConfigured ? "true" : "false"}">` +
    `<h2>用量</h2>` +
    `<table class="usage-table"><thead><tr><th>任务</th><th>输入 tokens</th>` +
    `<th>输出 tokens</th><th>调用次数</th><th>费用</th></tr></thead>` +
    `<tbody>${usageRows(usage)}</tbody>` +
    `<tfoot><tr><th scope="row">合计</th>` +
    `<td>${String(totals.inputTokens)}</td>` +
    `<td>${String(totals.outputTokens)}</td>` +
    `<td>${String(totals.calls)}</td>` +
    `<td>${escapeHtml(
      costCell(totals.costCents, totals.pricingConfigured),
    )}</td></tr></tfoot></table>` +
    (totals.pricingConfigured
      ? ""
      : `<p class="usage-note">仅用量：未配置价格，不显示金额。</p>`) +
    `</section>`
  );
}

function watchPanel(model: SettingsPageModel): string {
  const watch = model.watch;
  const reason =
    watch.reason ??
    (watch.available ? "" : "此项目不支持后台轮询，请使用手动刷新。");
  const disabled = watch.available ? "" : " disabled";
  const reasonMarkup =
    reason === ""
      ? ""
      : `<p class="watch-reason" id="watch-reason">${escapeHtml(reason)}</p>`;
  const described =
    reason === ""
      ? ""
      : ` title="${escapeAttribute(reason)}" aria-describedby="watch-reason"`;
  return (
    `<section class="panel watch-panel" data-watch-panel="true" ` +
    `data-project-id="" data-available="${watch.available ? "true" : "false"}" ` +
    `data-enabled="${watch.enabled ? "true" : "false"}">` +
    `<h2>跟进</h2>` +
    `<label class="watch-label"><input type="checkbox" ` +
    `data-testid="settings-watch-toggle" name="watchEnabled" ` +
    `${watch.enabled ? "checked" : ""}${disabled}${described}> 开启后台轮询</label>` +
    reasonMarkup +
    `<p>最近轮询：${formatTimestamp(watch.lastPollAt)}</p>` +
    `<button type="button" data-testid="settings-watch-refresh" ` +
    `data-refresh-now="true">手动刷新</button>` +
    `</section>`
  );
}

function preferencesPanel(model: SettingsPageModel): string {
  const preferences = model.preferences.preferences;
  const plainFirst = preferences.explainLevel === "plain_first";
  const positions =
    model.preferences.readingPositions.length === 0
      ? `<li class="empty">尚无阅读位置。</li>`
      : model.preferences.readingPositions
          .map(
            (position) =>
              `<li data-generation-id="${escapeAttribute(position.generationId)}" ` +
              `data-lesson-id="${escapeAttribute(position.lessonId)}" ` +
              `data-offset="${String(position.offset)}">` +
              `${escapeHtml(position.generationId)} / ` +
              `${escapeHtml(position.lessonId)} · 偏移 ` +
              `${String(position.offset)}</li>`,
          )
          .join("");

  const firstPosition = model.preferences.readingPositions[0];
  const positionForm =
    firstPosition === undefined
      ? ""
      : `<form class="reading-position-form" data-reading-position-form ` +
        `data-generation-id="${escapeAttribute(firstPosition.generationId)}" ` +
        `data-lesson-id="${escapeAttribute(firstPosition.lessonId)}">` +
        `<label>阅读位置偏移<input name="offset" type="number" min="0" ` +
        `value="${String(firstPosition.offset)}"></label>` +
        `<button type="submit">保存阅读位置</button></form>`;

  return (
    `<section class="panel preferences" data-testid="settings-preferences">` +
    `<h2>偏好</h2>` +
    `<form data-preferences-form>` +
    `<label>解释偏好<select name="explainLevel">` +
    `<option value="plain_first"${plainFirst ? " selected" : ""}>先通俗后技术</option>` +
    `<option value="technical_first"${plainFirst ? "" : " selected"}>` +
    `先技术后通俗</option></select></label>` +
    `<label>自述基础<textarea name="background" rows="3">` +
    `${escapeHtml(preferences.background ?? "")}</textarea></label>` +
    `<button type="submit">保存偏好</button>` +
    `</form>` +
    `<h3>阅读位置</h3>` +
    `<ul class="reading-positions">${positions}</ul>` +
    positionForm +
    `</section>`
  );
}

function storagePanel(model: SettingsPageModel): string {
  const storage = model.storage;
  return (
    `<section class="panel" data-testid="settings-storage">` +
    `<h2>存储</h2>` +
    `<p>总大小：${String(storage.totalBytes)} 字节</p>` +
    `<p>项目 ${String(storage.byProject.length)} 个 · ` +
    `生成版本 ${String(storage.byGeneration.length)} 个 · ` +
    `快照 ${String(storage.bySnapshot.length)} 个 · ` +
    `会话 ${String(storage.byConversation.length)} 个</p>` +
    `</section>`
  );
}

/** Renders `GET /settings`. */
export function renderSettingsPage(
  ctx: PageContext,
  model: SettingsPageModel,
): string {
  const body =
    `<header class="page-head"><h1>设置</h1></header>` +
    `<div class="settings-grid">` +
    modelScope(model) +
    usagePanel(model) +
    watchPanel(model) +
    preferencesPanel(model) +
    storagePanel(model) +
    `</div>` +
    `<p class="polling-note" data-testid="polling-note">` +
    `${escapeHtml(model.pollingNote)}</p>`;

  return renderPageShell(ctx, "设置", "settings", body);
}
