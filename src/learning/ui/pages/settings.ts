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
    `<section class="panel" id="settings-model-scope" data-testid="settings-model-scope" ` +
    `data-pricing-configured="${model.model.pricingConfigured ? "true" : "false"}">` +
    `<h2>模型与发送范围</h2>` +
    `<form data-model-settings-form data-api-key-configured="${model.model.apiKeyConfigured === true}"><div class="form-row"><label>模型服务<select name="provider"><option value="anthropic"${model.model.provider === "anthropic" ? " selected" : ""}>Anthropic</option>${model.model.provider === "fixture" ? '<option value="fixture" selected>本地测试模型</option>' : ""}</select></label>` +
    `<label>模型 ID<input name="model" required value="${escapeAttribute(model.model.model)}" placeholder="输入你的模型 ID" autocomplete="off"></label></div>` +
    `<label>Base URL（可选）<input name="baseUrl" type="url" value="${escapeAttribute(model.model.baseUrl ?? "")}" placeholder="https://api.anthropic.com" autocomplete="off" aria-describedby="model-base-url-hint"></label>` +
    `<p class="hint" id="model-base-url-hint">Anthropic Messages API 服务根地址，无需填写 /v1/messages。留空使用启动环境变量或官方地址；已填写的地址优先。</p>` +
    `<label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${model.model.apiKeyConfigured ? "已配置，留空保留现有 Key" : "输入 API Key，或使用已配置的环境变量"}"></label>` +
    `<p class="hint">${model.model.apiKeyConfigured ? "凭据已配置" : "凭据未配置"}。仅保存在本机，不会显示在页面或写入生成内容。</p>` +
    `<details><summary>输出与配额</summary><div class="form-row"><label>单次输出上限<input name="maxOutputTokens" type="number" min="1" required value="${model.model.maxOutputTokens ?? 4096}"></label><label>温度<input name="temperature" type="number" min="0" step="0.1" required value="${model.model.temperature ?? 0.2}"></label></div>` +
    `<p class="hint">以下配额按任务类别累计；0 表示不限额。</p><div class="form-row"><label>调用次数<input name="maxCalls" type="number" min="0" required value="${model.model.quota.maxCalls}"></label><label>输入 token 上限<input name="maxInputTokens" type="number" min="0" required value="${model.model.quota.maxInputTokens}"></label><label>输出 token 上限<input name="quotaMaxOutputTokens" type="number" min="0" required value="${model.model.quota.maxOutputTokens}"></label></div></details>` +
    `<div class="form-actions"><button type="submit" class="primary">保存模型配置</button><button type="button" data-model-test>测试连接</button></div>` +
    `<p class="hint">测试使用当前输入，Key 留空时使用已配置凭据；仅发送固定测试文本，会产生少量模型用量，不发送项目内容，也不会保存配置。</p>` +
    `<p class="form-status" data-form-status role="status" aria-live="polite"></p></form>` +
    `<details><summary>发送给模型的内容范围</summary><p>读取范围内的代码、引用位置、你的问题、偏好和当前会话历史会发往所选模型服务。</p><ul class="data-sent">${dataSent}</ul></details>` +
    `<p class="hint">价格：${model.model.pricingConfigured ? "已配置" : "未配置（仅显示用量）"}</p>` +
    `</section>`
  );
}

function usagePanel(model: SettingsPageModel): string {
  const usage = model.usage;
  const totals = usage.totals;
  return (
    `<section class="panel" id="settings-usage" data-testid="settings-usage" ` +
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
    `<section class="panel watch-panel" id="settings-watch" data-watch-panel="true" ` +
    `data-project-id="${escapeAttribute(model.projectId)}" ` +
    `data-available="${watch.available ? "true" : "false"}" ` +
    `data-enabled="${watch.enabled ? "true" : "false"}">` +
    `<h2>跟进</h2>` +
    `<label class="watch-label"><input type="checkbox" ` +
    `data-testid="settings-watch-toggle" name="watchEnabled" ` +
    `${watch.enabled ? "checked" : ""}${disabled}${described}> 开启后台轮询</label>` +
    reasonMarkup +
    `<p>最近轮询：${formatTimestamp(watch.lastPollAt)}</p>` +
    `<button type="button" data-testid="settings-watch-refresh" ` +
    `data-refresh-now="true"${watch.available ? "" : " disabled"}>手动刷新</button>` +
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

  return (
    `<section class="panel preferences" id="settings-preferences" data-testid="settings-preferences">` +
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
    `<details><summary>已保存的阅读位置</summary><ul class="reading-positions">${positions}</ul></details>` +
    `<p class="hint">阅读位置在阅读页自动保存，无需手动输入偏移。</p>` +
    `</section>`
  );
}

function storagePanel(model: SettingsPageModel): string {
  const storage = model.storage;
  return (
    `<section class="panel" id="settings-storage" data-testid="settings-storage">` +
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
    `<header class="page-head"><div><span class="eyebrow">让解释适合你</span><h1>设置</h1><p>模型配置对新任务立即生效；阅读中的版本保持固定。</p></div>${model.projectId ? `<a class="button" href="/?project=${escapeAttribute(model.projectId)}">返回项目 →</a>` : ""}</header>` +
    `<div class="settings-layout"><nav class="settings-nav" aria-label="设置分组"><a href="#settings-model-scope">模型与凭据</a><a href="#settings-preferences">解释偏好</a><a href="#settings-usage">用量</a><a href="#settings-watch">项目跟进</a><a href="#settings-storage">存储</a></nav><div class="settings-grid">` +
    modelScope(model) +
    usagePanel(model) +
    watchPanel(model) +
    preferencesPanel(model) +
    storagePanel(model) +
    `</div></div>` +
    `<p class="polling-note" data-testid="polling-note">` +
    `${escapeHtml(model.pollingNote)}</p>`;

  return renderPageShell(
    { ...ctx, projectId: model.projectId },
    "设置",
    "settings",
    body,
  );
}
