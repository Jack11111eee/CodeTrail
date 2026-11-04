/**
 * Projects entry page (architecture §15, AC-UI-01).
 *
 * The page is a plain server-rendered document: project cards, the two import
 * forms, the job/model status panel and the removal confirmation surface. It
 * never fetches; `client.ts` progressively enhances the forms.
 */

import type {
  ProjectSummary,
  ProjectsPageModel,
} from "../../contracts/index.js";
import { escapeAttribute, escapeHtml } from "../render/markdown.js";
import {
  formatTimestamp,
  jobStateLabel,
  renderPageShell,
  shortSha,
} from "./layout.js";
import type { PageContext } from "./layout.js";

export type { PageContext } from "./layout.js";

function projectRow(project: ProjectSummary): string {
  return (
    `<tr data-project-id="${escapeAttribute(project.projectId)}" ` +
    `data-repo-kind="${escapeAttribute(project.kind)}">` +
    `<td>${escapeHtml(project.displayName)}</td>` +
    `<td>${escapeHtml(project.defaultBranch ?? "—")}</td>` +
    `<td><code>${shortSha(project.analyzedCommitSha)}</code></td>` +
    `<td>${formatTimestamp(project.lastSuccessAt)}</td>` +
    `<td>${escapeHtml(jobStateLabel(project.latestJobState))}</td>` +
    `</tr>`
  );
}

function projectCard(project: ProjectSummary): string {
  return (
    `<li class="project-card" data-project-id="${escapeAttribute(project.projectId)}" ` +
    `data-repo-kind="${escapeAttribute(project.kind)}">` +
    `<h3><a href="/learn?project=${escapeAttribute(project.projectId)}">` +
    `${escapeHtml(project.displayName)}</a></h3>` +
    `<dl class="project-meta">` +
    `<dt>仓库</dt><dd>${escapeHtml(project.displayName)}</dd>` +
    `<dt>分支</dt><dd>${escapeHtml(project.defaultBranch ?? "—")}</dd>` +
    `<dt>分析提交</dt><dd><code>${shortSha(project.analyzedCommitSha)}</code></dd>` +
    `<dt>最近成功</dt><dd>${formatTimestamp(project.lastSuccessAt)}</dd>` +
    `<dt>任务状态</dt><dd>${escapeHtml(jobStateLabel(project.latestJobState))}</dd>` +
    `<dt>跟进</dt><dd>${project.watchEnabled ? "已开启" : "未开启"}</dd>` +
    `</dl>` +
    `<button type="button" data-select-project="${escapeAttribute(project.projectId)}">` +
    `查看移除依赖</button></li>`
  );
}

/** Renders `GET /`. */
export function renderProjectsPage(
  ctx: PageContext,
  model: ProjectsPageModel,
): string {
  const projects = model.projects ?? [];
  const rows = projects.map(projectRow).join("");
  const cards = projects.map(projectCard).join("");
  const empty = projects.length === 0;

  const body =
    `<header class="page-head"><h1>项目</h1>` +
    `<p>添加本地目录或 GitHub 仓库，固定版本研究或开启跟进。大仓库可以限定目录；` +
    `未分析路径会明确标记。</p></header>` +
    `<section class="panel" data-testid="project-status" ` +
    `data-model-configured="${model.modelConfigured ? "true" : "false"}">` +
    `<h2>状态</h2>` +
    `<p class="model-state">模型：${model.modelConfigured ? "已配置" : "未配置"}</p>` +
    (empty
      ? `<p class="empty">尚无项目。</p>`
      : `<table class="status-table"><thead><tr><th>仓库</th><th>分支</th>` +
        `<th>分析提交</th><th>最近成功</th><th>任务状态</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`) +
    `<p class="polling-note" data-testid="polling-note">` +
    `${escapeHtml(model.pollingNote)}</p>` +
    `</section>` +
    `<div class="add-grid">` +
    `<form class="panel" data-testid="project-add-local" data-project-kind="local" ` +
    `method="post" action="/api/projects">` +
    `<h2>添加本地项目</h2>` +
    `<label>本地路径<input name="localPath" type="text" required autocomplete="off" ` +
    `placeholder="/absolute/path/to/repo"></label>` +
    `<button type="submit">添加本地项目</button>` +
    `</form>` +
    `<form class="panel" data-testid="project-add-github" data-project-kind="github" ` +
    `method="post" action="/api/projects">` +
    `<h2>添加 GitHub 项目</h2>` +
    `<label>GitHub URL<input name="githubUrl" type="url" required ` +
    `placeholder="https://github.com/owner/repo"></label>` +
    `<label>分支或提交（可选）<input name="ref" type="text" autocomplete="off"></label>` +
    `<button type="submit">添加 GitHub 项目</button>` +
    `</form>` +
    `</div>` +
    `<section class="panel"><h2>项目列表</h2>` +
    `<ul class="project-list" data-testid="project-list">` +
    (empty ? `<li class="empty">尚无项目</li>` : cards) +
    `</ul></section>` +
    `<section class="panel" data-testid="project-dependents" data-project-id="">` +
    `<h2>移除项目前的依赖</h2>` +
    `<p>移除前会先列出会话、讲解、生成版本与更新记录；确认后旧链接显示不可用，` +
    `不会跳转到最新版本。</p>` +
    `<ul class="dependent-list"></ul>` +
    `</section>` +
    `<form class="panel remove-project" data-remove-project data-project-id="">` +
    `<label><input data-testid="project-remove-confirm" type="checkbox" ` +
    `name="confirm" value="true"> 我确认移除该项目及其依赖</label>` +
    `<button type="submit" disabled>移除项目</button>` +
    `</form>`;

  return renderPageShell(ctx, "项目", "projects", body);
}
