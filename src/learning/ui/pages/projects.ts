/** Project workspace: one list, state-dependent actions and on-demand import. */
import type {
  ProjectSummary,
  ProjectsPageModel,
} from "../../contracts/index.js";
import { escapeAttribute as a, escapeHtml as h } from "../render/markdown.js";
import {
  formatTimestamp,
  jobStateLabel,
  renderPageShell,
  shortSha,
} from "./layout.js";
import type { PageContext } from "./layout.js";
export type { PageContext } from "./layout.js";

function projectCard(project: ProjectSummary, configured: boolean): string {
  const id = a(project.projectId);
  const reading = project.generationId
    ? `/learn/reader?generation=${a(project.generationId)}`
    : `/learn?project=${id}`;
  const ready = project.analyzedCommitSha !== null;
  const retryable =
    Boolean(project.latestJobId) &&
    ["failed", "cancelled", "interrupted"].includes(
      project.latestJobState ?? "",
    );
  const retryLabel = project.latestJobResumeAvailable
    ? "从断点继续"
    : "重试分析";
  const busy = ["queued", "running", "cancelling"].includes(
    project.latestJobState ?? "",
  );
  return `<li class="project-card" data-project-id="${id}" data-repo-kind="${a(project.kind)}">
    <div class="project-heading"><div><span class="eyebrow">${project.kind === "local" ? "本地项目" : "GitHub 项目"}</span><h2><a href="${reading}">${h(project.displayName)}</a></h2>
    <p class="project-summary">${h(project.defaultBranch ?? "默认版本")} <span aria-hidden="true">·</span> 提交 <code>${shortSha(project.analyzedCommitSha)}</code> <span aria-hidden="true">·</span> ${ready ? `最近成功 ${formatTimestamp(project.lastSuccessAt)}` : "尚未生成讲解"}</p></div>
    <div class="project-actions">${!configured ? `<a class="button primary" href="/settings?project=${id}">配置模型</a>` : ready ? `<a class="button primary" href="${reading}">继续学习 <span aria-hidden="true">→</span></a>` : retryable ? `<button class="primary" type="button" data-primary-job-action="retry">${retryLabel}</button>` : `<button class="primary" type="submit" form="analysis-${id}" ${busy ? "disabled" : ""}>${busy ? "正在分析" : "开始分析"}</button>`}<a class="button quiet" href="/inbox?project=${id}">查看更新</a></div></div>
    <div class="job-status" data-project-job data-job-id="${a(project.latestJobId ?? "")}" data-job-state="${a(project.latestJobState ?? "")}" aria-live="polite"><span data-job-status>${project.latestJobState ? h(jobStateLabel(project.latestJobState)) : ready ? "讲解已就绪" : "准备好后即可开始分析"}</span><span data-job-detail></span><button type="button" class="quiet" data-open-job ${project.latestJobId ? "" : "hidden"}>查看分析过程</button><button type="button" class="quiet" data-job-action="cancel" ${busy ? "" : "hidden"}>取消任务</button><button type="button" data-job-action="retry" ${["failed", "cancelled", "interrupted"].includes(project.latestJobState ?? "") ? "" : "hidden"}>${retryLabel}</button></div>
    <details class="project-manage"><summary>版本与项目管理</summary><form id="analysis-${id}" data-analysis-form data-project-id="${id}"><div class="form-row"><label>分支、标签或提交<input name="ref" required value="${a(project.defaultBranch ?? "HEAD")}" autocomplete="off"></label><label>读取目录（可选）<input name="include" placeholder="src/**，README.md" autocomplete="off"></label></div><p class="hint">仅分析已提交内容；默认排除依赖、缓存与密钥文件。</p><button type="submit" ${!configured || busy ? "disabled" : ""}>${ready ? "重新分析此版本" : "开始分析"}</button></form>
    <div class="management-footer"><a href="/settings?project=${id}&section=watch">${project.watchEnabled ? "跟进已开启" : "设置项目跟进"}</a><button type="button" class="danger quiet" data-select-project="${id}" data-project-name="${a(project.displayName)}">移除项目…</button></div></details>
  </li>`;
}

function analysisPanel(): string {
  return `<dialog id="analysis-progress" class="job-progress-dialog" aria-labelledby="analysis-progress-title">
    <header class="job-board-heading"><div><span class="eyebrow">分析过程</span><h2 id="analysis-progress-title" data-board-title>项目分析</h2></div><button type="button" class="quiet" data-close-dialog aria-label="关闭分析面板">关闭</button></header>
    <div class="job-board-content"><div class="job-board-summary"><span class="job-state-badge" data-board-state>正在读取任务</span><span data-board-attempt></span><span data-board-elapsed></span></div><p class="job-board-meta" data-board-meta></p>
    <ol class="job-steps" data-board-steps aria-label="分析阶段"></ol>
    <section class="job-current"><h3>当前动作</h3><p data-board-current role="status" aria-live="polite">正在读取任务信息…</p><div data-board-pages hidden><div class="job-page-count"><span>项目文档</span><span data-board-count></span></div><progress data-board-page-progress aria-label="项目文档生成进度"></progress><p class="hint" data-board-page></p></div></section>
    <section class="job-board-error" data-board-error role="alert" hidden></section>
    <section class="job-activity-section"><div class="job-activity-heading"><h3>最近活动</h3><span data-board-updated></span></div><p class="hint">保留最近 100 条关键活动，刷新后仍可查看。</p><ol class="job-timeline" data-board-activities></ol></section></div>
    <footer class="job-board-footer"><p class="hint" data-board-connection>正在连接任务进度…</p><div class="form-actions"><a class="button primary" data-board-result hidden>开始学习 →</a><button type="button" class="quiet" data-board-job-action="cancel" hidden>取消分析</button><button type="button" data-board-job-action="retry" hidden>重试分析</button></div><p data-form-status role="status" aria-live="polite"></p></footer>
    </dialog>`;
}

export function renderProjectsPage(
  ctx: PageContext,
  model: ProjectsPageModel,
): string {
  const empty = model.projects.length === 0;
  const body = `<header class="page-head"><div><span class="eyebrow">你的代码学习空间</span><h1>我的项目</h1><p>从一个真实流程开始，沿着代码证据理解它。</p></div><button type="button" class="primary" data-open-dialog="import-project">＋ 添加项目</button></header>
    <section class="setup-state" data-testid="project-status" data-model-configured="${model.modelConfigured}">${model.modelConfigured ? `<div><span class="status-dot" aria-hidden="true"></span>模型已配置，选择项目开始学习。</div>` : `<div><strong>先连接模型，再开始学习</strong><p>模型未配置。添加项目后，也可以随时回来继续分析。</p></div><a class="button" href="/settings">配置模型 →</a>`}</section>
    <ul class="project-list" data-testid="project-list">${empty ? `<li class="empty-state"><span class="empty-symbol" aria-hidden="true">⌘</span><h2>尚无项目</h2><p>添加本地 Git 目录或 GitHub 仓库，生成第一份讲解。</p><button type="button" class="primary" data-open-dialog="import-project">添加第一个项目</button></li>` : model.projects.map((p) => projectCard(p, model.modelConfigured)).join("")}</ul>
    <dialog id="import-project" class="import-dialog"><div class="dialog-heading"><h2>添加项目</h2><button type="button" class="quiet" data-close-dialog aria-label="关闭添加项目">关闭</button></div><div class="import-tabs" role="group" aria-label="项目来源"><button type="button" data-import-kind="github" aria-pressed="true">GitHub 仓库</button><button type="button" data-import-kind="local" aria-pressed="false">本地 Git 项目</button></div>
    <form data-testid="project-add-github" data-project-kind="github" data-model-configured="${model.modelConfigured}" method="post" action="/api/projects"><label>GitHub URL<input name="githubUrl" type="url" required placeholder="https://github.com/owner/repo"></label><details><summary>选择版本</summary><label>分支、标签或提交（可选）<input name="ref" autocomplete="off" placeholder="默认分支"></label></details><p class="hint">导入独立快照，不修改原仓库。</p><button type="submit" class="primary">${model.modelConfigured ? "添加并开始分析" : "添加项目"}</button></form>
    <form data-testid="project-add-local" data-project-kind="local" data-model-configured="${model.modelConfigured}" method="post" action="/api/projects" hidden><label>本地 Git 仓库路径<input name="localPath" required autocomplete="off" placeholder="/absolute/path/to/repo"></label><p class="hint">只读取已提交内容，包括尚未推送的提交。</p><button type="submit" class="primary">${model.modelConfigured ? "添加并开始分析" : "添加项目"}</button></form></dialog>
    <dialog id="remove-project" class="remove-dialog"><div class="dialog-heading"><h2>移除项目</h2><button type="button" class="quiet" data-close-dialog>关闭</button></div><section data-testid="project-dependents" data-project-id=""><h3 data-removal-name></h3><p>移除后旧链接将显示不可用，相关任务会取消。</p><ul class="dependent-list"></ul></section><form data-remove-project data-project-id=""><label class="checkbox-label"><input data-testid="project-remove-confirm" name="confirm" type="checkbox" required>我确认移除该项目及其依赖</label><button class="danger" type="submit" disabled>确认移除</button></form></dialog>
    <details class="product-note"><summary>关于后台跟进</summary><p class="polling-note" data-testid="polling-note">${h(model.pollingNote)}</p></details>`;
  return renderPageShell(ctx, "项目", "projects", body + analysisPanel());
}
