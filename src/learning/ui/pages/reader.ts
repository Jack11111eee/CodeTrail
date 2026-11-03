/**
 * Three-column reader (architecture §15, AC-UI-02/03/04/05).
 *
 * Left: lesson navigation. Middle: the active lesson with one expanded
 * scenario, a few key concepts and four collapsed blocks (original code, deep
 * mechanics, alternatives, prerequisites). Right: the QA stream, its citations
 * and the question form. A narrow screen stacks the three regions via the
 * stylesheet's 900px query.
 */

import type {
  CitationView,
  CoverageReport,
  ExclusionReason,
  LessonDetailView,
  LessonSummary,
  MessageView,
  ReaderPageModel,
} from "../../contracts/index.js";
import { renderDiagram } from "../render/diagram.js";
import {
  escapeAttribute,
  escapeHtml,
  renderMarkdownSafe,
  sanitizeHtml,
} from "../render/markdown.js";
import { collapsedDetails, renderPageShell, shortSha } from "./layout.js";
import type { PageContext } from "./layout.js";

export type { PageContext } from "./layout.js";

const LABEL_TEXT: Readonly<Record<string, string>> = {
  code_fact: "代码事实",
  recorded_design_rationale: "记录的设计理由",
  engineering_analysis: "工程分析",
  teaching_example: "教学示例",
};

const GAP_REASON_TEXT: Readonly<Record<ExclusionReason, string>> = {
  excluded_default_dir: "默认排除目录",
  excluded_secret: "疑似密钥",
  excluded_binary: "二进制文件",
  excluded_data: "数据文件",
  excluded_too_large: "文件过大",
  excluded_by_scope: "被读取范围排除",
  submodule_not_fetched: "子模块未获取",
  lfs_not_fetched: "LFS 对象未获取",
  uncommitted_excluded: "未提交内容不读取",
  untracked_excluded: "未跟踪内容不读取",
};

function gapReasonText(reason: string): string {
  return GAP_REASON_TEXT[reason as ExclusionReason] ?? reason;
}

function navLink(
  generationId: string,
  lesson: LessonSummary,
  activeLessonId: string | null,
): string {
  const active = lesson.lessonId === activeLessonId;
  return (
    `<li${active ? ' class="active"' : ""}>` +
    `<a href="/learn/reader?generation=${escapeAttribute(generationId)}` +
    `&lesson=${escapeAttribute(lesson.lessonId)}"` +
    `${active ? ' aria-current="page"' : ""}>` +
    `${escapeHtml(lesson.title)}</a>` +
    `<span class="lesson-kind">${escapeHtml(lesson.kind)}</span>` +
    `</li>`
  );
}

function renderNav(model: ReaderPageModel): string {
  const activeLessonId = model.activeLesson?.lesson.lessonId ?? null;
  const lessons =
    model.lessons.length === 0
      ? `<li class="empty">尚无讲解。</li>`
      : model.lessons
          .map((lesson) => navLink(model.generationId, lesson, activeLessonId))
          .join("");
  const position =
    model.readingPosition === null
      ? `<p class="reading-position">尚无阅读位置。</p>`
      : `<p class="reading-position" data-reading-position-offset="` +
        `${String(model.readingPosition.offset)}">上次读到 ` +
        `${escapeHtml(model.readingPosition.lessonId)}（偏移 ` +
        `${String(model.readingPosition.offset)}）</p>`;

  return (
    `<nav class="reader-nav" data-testid="reader-nav">` +
    `<h2>${escapeHtml(model.repoDisplayName)}</h2>` +
    `<p class="commit">提交 <code>${shortSha(model.commitSha)}</code></p>` +
    `<ul class="lesson-nav">${lessons}</ul>` +
    position +
    `<p class="polling-note" data-testid="polling-note">` +
    `${escapeHtml(model.pollingNote)}</p>` +
    `</nav>`
  );
}

function sourceHref(generationId: string, sourceId: string): string {
  return (
    `/learn/reader?generation=${escapeAttribute(generationId)}` +
    `&source=${escapeAttribute(sourceId)}`
  );
}

function emptyBlock(name: string): string {
  return `<p class="empty">${escapeHtml(name)}暂无内容。</p>`;
}

function renderPlain(
  model: ReaderPageModel,
  detail: LessonDetailView | null,
): string {
  if (detail === null) {
    return `<section data-testid="lesson-plain">${emptyBlock("讲解")}</section>`;
  }
  const lesson = detail.lesson;
  const scenario = lesson.scenario;
  const overview =
    lesson.overview.length === 0
      ? emptyBlock("模块职责")
      : `<ul class="overview">${lesson.overview
          .map(
            (module) =>
              `<li data-module-id="${escapeAttribute(module.moduleId)}">` +
              `<strong>${escapeHtml(module.moduleId)}</strong>：` +
              `${escapeHtml(module.responsibility)}` +
              `<span class="io">输入 ${escapeHtml(module.inputs.join("、") || "—")}；` +
              `输出 ${escapeHtml(module.outputs.join("、") || "—")}</span></li>`,
          )
          .join("")}</ul>`;
  const plain =
    lesson.plainExplanation.length === 0
      ? emptyBlock("通俗解释")
      : `<ul class="plain-list">${lesson.plainExplanation
          .map(
            (item) =>
              `<li data-mechanism-id="${escapeAttribute(item.mechanismId)}">` +
              `${escapeHtml(item.text)}</li>`,
          )
          .join("")}</ul>`;
  const rendered =
    detail.html === ""
      ? ""
      : `<div class="lesson-rendered">${sanitizeHtml(detail.html, {
          allowMermaidCodeBlocks: true,
        })}</div>`;

  return (
    `<section class="lesson-block" data-testid="lesson-plain">` +
    `<h2>先看一个场景</h2>` +
    `<section class="scenario" data-expanded="true" ` +
    `data-scenario-id="${escapeAttribute(scenario.id)}" ` +
    `data-scenario-kind="${escapeAttribute(scenario.kind)}">` +
    `<p class="scenario-action">用户操作：${escapeHtml(scenario.userAction)}</p>` +
    `<p>输入：${escapeHtml(scenario.inputs.join("、") || "—")}</p>` +
    `<p>可观察结果：${escapeHtml(scenario.observableResult)}</p>` +
    `<p class="example-note">这是教学示例。</p>` +
    `</section>` +
    `<h3>模块职责与输入输出</h3>${overview}` +
    `<h3>通俗解释</h3>${plain}${rendered}` +
    `</section>`
  );
}

function renderTechnical(
  detail: LessonDetailView | null,
  generationId: string,
): string {
  if (detail === null) {
    return `<section data-testid="lesson-technical">${emptyBlock("技术细节")}</section>`;
  }
  const lesson = detail.lesson;
  const mechanics =
    lesson.technicalExplanation.length === 0
      ? emptyBlock("深入原理")
      : `<ul class="technical-list">${lesson.technicalExplanation
          .map(
            (item) =>
              `<li data-mechanism-id="${escapeAttribute(item.mechanismId)}">` +
              `${escapeHtml(item.text)}` +
              `<span class="terms">术语：${escapeHtml(
                item.terms
                  .map((term) => `${term.zh} / ${term.en}`)
                  .join("、") || "—",
              )}</span></li>`,
          )
          .join("")}</ul>`;
  const code =
    lesson.evidence.length === 0
      ? `<p class="empty">原始代码通过证据来源打开；本讲解没有额外代码引用。</p>`
      : `<p>原始代码按证据来源与行号展示：</p><ul class="evidence-links">` +
        lesson.evidence
          .map(
            (sourceId) =>
              `<li><a href="${sourceHref(generationId, sourceId)}">` +
              `${escapeHtml(sourceId)}</a></li>`,
          )
          .join("") +
        `</ul>`;

  return (
    `<section class="lesson-block" data-testid="lesson-technical">` +
    `<h2>技术细节</h2>` +
    `<p>默认收起深入原理与原始代码，按需展开。</p>` +
    collapsedDetails("深入原理", mechanics, "deep-mechanics") +
    collapsedDetails("原始代码", code, "code") +
    `</section>`
  );
}

function renderChoices(detail: LessonDetailView | null): string {
  if (detail === null) {
    return `<section data-testid="lesson-choices">${emptyBlock("取舍")}</section>`;
  }
  const lesson = detail.lesson;
  if (lesson.choices.length === 0) {
    const reason =
      lesson.choicesOmittedReason === null
        ? "本讲解没有记录取舍。"
        : `本讲解没有记录取舍：${lesson.choicesOmittedReason}`;
    return (
      `<section class="lesson-block" data-testid="lesson-choices">` +
      `<h2>取舍</h2><p class="empty">${escapeHtml(reason)}</p>` +
      collapsedDetails("替代方案", emptyBlock("替代方案"), "alternatives") +
      `</section>`
    );
  }

  const decisions = lesson.choices
    .map(
      (choice) =>
        `<li data-decision="${escapeAttribute(choice.decision)}">` +
        `<strong>${escapeHtml(choice.decision)}</strong>：当前选择 ` +
        `${escapeHtml(choice.current)}</li>`,
    )
    .join("");
  const alternatives = lesson.choices
    .flatMap((choice) => choice.alternatives)
    .map(
      (alternative) =>
        `<li><strong>${escapeHtml(alternative.option)}</strong>` +
        `<span>适用：${escapeHtml(alternative.whenItFits)}</span>` +
        `<span>代价：${escapeHtml(alternative.cost)}</span></li>`,
    )
    .join("");

  return (
    `<section class="lesson-block" data-testid="lesson-choices">` +
    `<h2>取舍</h2><ul class="choices">${decisions}</ul>` +
    collapsedDetails(
      "替代方案",
      alternatives === "" ? emptyBlock("替代方案") : `<ul>${alternatives}</ul>`,
      "alternatives",
    ) +
    `</section>`
  );
}

function renderBoundaries(detail: LessonDetailView | null): string {
  if (detail === null) {
    return `<section data-testid="lesson-boundaries">${emptyBlock("边界")}</section>`;
  }
  const lesson = detail.lesson;
  const boundaries =
    lesson.boundaries.length === 0
      ? emptyBlock("边界")
      : `<ul class="boundaries">${lesson.boundaries
          .map(
            (boundary) =>
              `<li data-status="${escapeAttribute(boundary.status)}">` +
              `<strong>${escapeHtml(boundary.item)}</strong>` +
              `<span class="boundary-status">${escapeHtml(boundary.status)}</span>` +
              `<span class="boundary-limits">${escapeHtml(boundary.limits)}</span></li>`,
          )
          .join("")}</ul>`;
  const terms = lesson.technicalExplanation
    .flatMap((item) => item.terms)
    .map((term) => `${term.zh} / ${term.en}`);

  return (
    `<section class="lesson-block" data-testid="lesson-boundaries">` +
    `<h2>边界与限制</h2>${boundaries}` +
    collapsedDetails(
      "前置基础",
      terms.length === 0
        ? `<p class="empty">没有额外前置基础。</p>`
        : `<p>阅读前建议先了解：${escapeHtml(terms.join("、"))}</p>`,
      "prerequisites",
    ) +
    `</section>`
  );
}

function renderEvidence(
  detail: LessonDetailView | null,
  generationId: string,
): string {
  if (detail === null) {
    return `<section data-testid="lesson-evidence">${emptyBlock("证据")}</section>`;
  }
  const lesson = detail.lesson;
  const statements =
    lesson.statements.length === 0
      ? emptyBlock("陈述")
      : `<ul class="statements">${lesson.statements
          .map(
            (statement) =>
              `<li data-label="${escapeAttribute(statement.label)}" ` +
              `data-evidence-ids="${escapeAttribute(statement.evidenceIds.join(","))}">` +
              `<span class="statement-label">${escapeHtml(
                LABEL_TEXT[statement.label] ?? statement.label,
              )}</span>${escapeHtml(statement.text)}</li>`,
          )
          .join("")}</ul>`;
  const sources =
    lesson.evidence.length === 0
      ? emptyBlock("证据来源")
      : `<ul class="evidence-links">${lesson.evidence
          .map(
            (sourceId) =>
              `<li data-source-id="${escapeAttribute(sourceId)}">` +
              `<a href="${sourceHref(generationId, sourceId)}">` +
              `${escapeHtml(sourceId)}</a></li>`,
          )
          .join("")}</ul>`;

  return (
    `<section class="lesson-block" data-testid="lesson-evidence">` +
    `<h2>证据与陈述标签</h2>${statements}` +
    `<h3>证据来源</h3>${sources}` +
    `</section>`
  );
}

function renderCoverage(coverage: CoverageReport | null): string {
  if (coverage === null) {
    return (
      `<section class="panel" data-testid="coverage-gaps" data-complete="false">` +
      `<h2>覆盖范围</h2><p class="coverage-notice">覆盖信息不可用，` +
      `不能声称已分析整个仓库。</p></section>`
    );
  }
  const gaps =
    coverage.gaps.length === 0
      ? `<p class="empty">未记录未分析路径。</p>`
      : `<ul class="coverage-gap-list">${coverage.gaps
          .map(
            (gap) =>
              `<li data-path="${escapeAttribute(gap.path)}" ` +
              `data-reason="${escapeAttribute(gap.reason)}">` +
              `<code>${escapeHtml(gap.path)}</code> — ` +
              `${escapeHtml(gapReasonText(gap.reason))}` +
              `${gap.detail === undefined ? "" : `：${escapeHtml(gap.detail)}`}</li>`,
          )
          .join("")}</ul>`;
  // A report is only complete when it also has no gaps. The flag alone is not
  // trusted: an inconsistent payload must never turn into a completeness claim.
  const complete = coverage.complete && coverage.gaps.length === 0;
  const notice = complete
    ? "覆盖报告：未记录未分析路径。"
    : "覆盖不完整：以下路径未被分析，结论不覆盖整个仓库，绝不声称完整。";

  return (
    `<section class="panel" data-testid="coverage-gaps" ` +
    `data-complete="${complete ? "true" : "false"}">` +
    `<h2>覆盖范围</h2>` +
    `<p class="coverage-notice">${escapeHtml(notice)}</p>${gaps}` +
    `<p class="coverage-counts">已分析 ${String(coverage.counts.analyzedFiles)} / ` +
    `${String(coverage.counts.totalFiles)} 个文件，排除 ` +
    `${String(coverage.counts.excludedFiles)} 个。</p>` +
    `</section>`
  );
}

function citationLink(citation: CitationView): string {
  return (
    `<li data-source-id="${escapeAttribute(citation.sourceId)}">` +
    `<a href="${sourceHref(citation.generationId, citation.sourceId)}">` +
    `${escapeHtml(citation.label)}</a>` +
    `<span class="availability">${escapeHtml(citation.availability)}</span></li>`
  );
}

function messageItem(message: MessageView): string {
  const content =
    message.role === "assistant"
      ? renderMarkdownSafe(message.content)
      : escapeHtml(message.content);
  return (
    `<li class="qa-message" data-role="${escapeAttribute(message.role)}" ` +
    `data-status="${escapeAttribute(message.status)}">` +
    `<span class="qa-role">${message.role === "assistant" ? "助手" : "你"}</span>` +
    `<div class="qa-content">${content}</div>` +
    (message.unknownReason === null
      ? ""
      : `<p class="unknown">未知：${escapeHtml(message.unknownReason)}</p>`) +
    (message.incomplete ? `<p class="incomplete">回答不完整。</p>` : "") +
    `</li>`
  );
}

function renderQa(model: ReaderPageModel): string {
  const messages = model.conversation?.messages ?? [];
  const citations = messages.flatMap((message) => message.citations);
  const conversationId = model.conversation?.conversationId ?? "";
  const stream =
    messages.length === 0
      ? `<li class="empty">尚无追问。</li>`
      : messages.map(messageItem).join("");
  const citationItems =
    citations.length === 0
      ? `<li class="empty">尚无引用。</li>`
      : citations.map(citationLink).join("");
  const action =
    conversationId === ""
      ? "/api/conversations"
      : `/api/conversations/${escapeAttribute(conversationId)}/messages`;

  return (
    `<aside class="reader-qa" data-testid="reader-qa">` +
    `<h2>追问</h2>` +
    `<ol class="qa-stream" data-testid="qa-stream">${stream}</ol>` +
    `<h3>引用</h3>` +
    `<ul class="qa-citations" data-testid="qa-citations">${citationItems}</ul>` +
    `<form class="qa-form" data-qa-form data-conversation-id="${escapeAttribute(
      conversationId,
    )}" data-generation-id="${escapeAttribute(model.generationId)}" ` +
    `method="post" action="${action}">` +
    `<label for="qa-input">你的问题</label>` +
    `<textarea data-testid="qa-input" id="qa-input" name="text" rows="3" ` +
    `placeholder="针对当前讲解或选中的代码提问"></textarea>` +
    `<input type="hidden" data-qa-selection-source name="selectionSource" value="">` +
    `<input type="hidden" data-qa-selection-commit name="selectionCommit" value="">` +
    `<button type="submit">发送</button>` +
    `</form>` +
    `</aside>`
  );
}

function renderLesson(model: ReaderPageModel): string {
  const detail = model.activeLesson;
  const title =
    detail === null
      ? "选择一个讲解"
      : `${detail.lesson.context.moduleIds.join(" · ") || "讲解"} / ${detail.lesson.kind}`;
  const diagram = detail === null ? "" : renderDiagram(detail.diagram);
  const readingOffset =
    model.readingPosition === null
      ? ""
      : ` data-reading-position="${String(model.readingPosition.offset)}"`;

  return (
    `<article class="reader-lesson" data-testid="reader-lesson"` +
    `${readingOffset}>` +
    `<header class="lesson-head"><h1>${escapeHtml(title)}</h1>` +
    `<p class="lesson-meta">生成版本 <code>${escapeHtml(model.generationId)}</code>` +
    ` · 提交 <code>${shortSha(model.commitSha)}</code></p></header>` +
    renderPlain(model, detail) +
    renderTechnical(detail, model.generationId) +
    renderChoices(detail) +
    renderBoundaries(detail) +
    renderEvidence(detail, model.generationId) +
    diagram +
    renderCoverage(model.coverage) +
    `</article>`
  );
}

/** Renders `GET /learn` and `GET /learn/reader`. */
export function renderReaderPage(
  ctx: PageContext,
  model: ReaderPageModel,
): string {
  const body =
    `<div class="reader-grid">` +
    renderNav(model) +
    renderLesson(model) +
    renderQa(model) +
    `</div>`;
  return renderPageShell(ctx, "阅读", "learn", body);
}
