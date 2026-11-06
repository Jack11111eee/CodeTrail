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
  conversationId?: string,
): string {
  const active = lesson.lessonId === activeLessonId;
  return (
    `<li${active ? ' class="active"' : ""}>` +
    `<a href="/learn/reader?generation=${escapeAttribute(generationId)}` +
    `&lesson=${escapeAttribute(lesson.lessonId)}${conversationId ? `&conversation=${escapeAttribute(conversationId)}` : ""}"` +
    `${active ? ' aria-current="page"' : ""}>` +
    `${escapeHtml(lesson.title)}</a>` +
    `<span class="lesson-kind">${escapeHtml({ research: "项目讲解", change: "变更讲解", comparison: "版本对比" }[lesson.kind])}</span>` +
    `</li>`
  );
}

function renderNav(model: ReaderPageModel): string {
  const activeLessonId = model.activeLesson?.lesson.lessonId ?? null;
  const lessons =
    model.lessons.length === 0
      ? `<li class="empty">尚无讲解。</li>`
      : model.lessons
          .map((lesson) =>
            navLink(
              model.generationId,
              lesson,
              activeLessonId,
              model.activeTopic
                ? undefined
                : model.conversation?.conversationId,
            ),
          )
          .join("");
  const position = model.activeTopic
    ? `<p class="reading-position">主题与追问记录自动保存到本机。</p>`
    : model.readingPosition === null
      ? `<p class="reading-position">尚无阅读位置，阅读时自动保存。</p>`
      : `<p class="reading-position" data-reading-position-offset="` +
        `${String(model.readingPosition.offset)}">已保存上次阅读位置。</p>`;

  return (
    `<nav class="reader-nav" data-testid="reader-nav">` +
    `<h2>${escapeHtml(model.repoDisplayName)}</h2>` +
    `<p class="commit">提交 <code>${shortSha(model.commitSha)}</code></p>` +
    `<p class="hint reader-howto">项目讲解由分析自动生成。想研究某个具体问题，点击“新建学习主题”；每个主题有独立讲解和追问记录。</p>` +
    `<h3 class="nav-section-title">项目讲解</h3><ul class="lesson-nav">${lessons}</ul>` +
    `<h3 class="nav-section-title">我的学习主题</h3><ul class="lesson-nav topic-nav">${(model.topics ?? []).map((topic) => `<li${topic.topicId === model.activeTopic?.topicId ? ' class="active"' : ""}><a href="/learn/reader?generation=${escapeAttribute(topic.generationId)}&topic=${escapeAttribute(topic.topicId)}"${topic.topicId === model.activeTopic?.topicId ? ' aria-current="page"' : ""}>${escapeHtml(topic.title || "未命名主题")}</a><span class="lesson-kind">${({ draft: "等待提问", generating: "正在生成", ready: "学习主题", failed: "可重试" } as const)[topic.state]}</span></li>`).join("") || '<li class="empty">从一个问题开始，创建自己的学习主题。</li>'}</ul>` +
    ((model.deletedTopics?.length ?? 0) > 0
      ? `<details class="deleted-topics"><summary>已删除的主题（${model.deletedTopics!.length}）</summary><ul>${model.deletedTopics!.map((topic) => `<li><span>${escapeHtml(topic.title || "未命名主题")}</span><button type="button" class="quiet" data-restore-topic="${escapeAttribute(topic.topicId)}" data-generation-id="${escapeAttribute(topic.generationId)}">恢复</button></li>`).join("")}</ul><p data-form-status role="status" aria-live="polite"></p></details>`
      : "") +
    ((model.deletedLessons?.length ?? 0) > 0
      ? `<details class="deleted-lessons"><summary>已删除的讲解（${model.deletedLessons!.length}）</summary><ul>${model.deletedLessons!.map((lesson) => `<li><span>${escapeHtml(lesson.title)}</span><button type="button" class="quiet" data-restore-lesson="${escapeAttribute(lesson.lessonId)}" data-generation-id="${escapeAttribute(model.generationId)}">恢复</button></li>`).join("")}</ul><p data-form-status role="status" aria-live="polite"></p></details>`
      : "") +
    position +
    `<details class="product-note"><summary>跟进说明</summary><p class="polling-note" data-testid="polling-note">${escapeHtml(model.pollingNote)}</p></details>` +
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
    collapsedDetails(
      `项目模块目录（${lesson.overview.length} 项）`,
      overview,
      "module-overview",
    ) +
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
              `查看代码依据</a></li>`,
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
              `<span class="boundary-status">${escapeHtml(({ implemented: "已实现", planned: "计划中", unknown: "待验证", not_implemented: "未实现" } as Record<string, string>)[boundary.status] ?? boundary.status)}</span>` +
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
              `<a data-source-link href="${sourceHref(generationId, sourceId)}">` +
              `查看代码依据</a></li>`,
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
    : coverage.gaps.length === 0
      ? "覆盖信息不完整：没有可用的覆盖报告，结论不覆盖整个仓库，绝不声称完整。"
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
    `<a data-source-link href="${sourceHref(citation.generationId, citation.sourceId)}">` +
    `${escapeHtml(citation.label)}</a>` +
    `<span class="availability" data-availability="${escapeAttribute(citation.availability)}">${citation.availability === "available" ? "可用" : "来源不可用"}</span></li>`
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
    (message.citations.length
      ? `<ul class="message-citations">${message.citations.map(citationLink).join("")}</ul>`
      : "") +
    `</li>`
  );
}

function renderQa(model: ReaderPageModel): string {
  const history = model.conversation?.messages ?? [];
  const firstAnswerIndex = model.activeTopic?.lessonMessageId
    ? history.findIndex(
        (message) => message.messageId === model.activeTopic!.lessonMessageId,
      )
    : -1;
  const messages =
    firstAnswerIndex >= 0 ? history.slice(firstAnswerIndex + 1) : history;
  const citations =
    messages.filter((message) => message.role === "assistant").at(-1)
      ?.citations ?? [];
  const conversationId = model.conversation?.conversationId ?? "";
  const stream =
    messages.length === 0
      ? `<li class="empty">尚无追问。</li>`
      : messages.map(messageItem).join("");
  const citationItems =
    citations.length === 0
      ? `<li class="empty">尚无引用。</li>`
      : citations.map(citationLink).join("");
  const action = model.activeTopic
    ? `/api/topics/${escapeAttribute(model.activeTopic.topicId)}/messages`
    : conversationId === ""
      ? "/api/conversations"
      : `/api/conversations/${escapeAttribute(conversationId)}/messages`;

  return (
    `<aside class="reader-qa" data-testid="reader-qa" aria-label="连续追问">` +
    `<div class="panel-heading"><h2>${model.activeTopic ? "围绕这个主题追问" : "围绕当前内容追问"}</h2><button type="button" class="quiet" data-reader-close>收起</button></div><p class="hint">${model.activeLesson ? "基于当前讲解和项目证据" : "基于已分析的项目证据"} · 提交 ${shortSha(model.commitSha)}。发送问题只会生成追问回答。</p>` +
    `<ol class="qa-stream" data-testid="qa-stream">${stream}</ol>` +
    `<details class="recent-citations"><summary>本次引用</summary><ul class="qa-citations" data-testid="qa-citations">${citationItems}</ul></details>` +
    `<form class="qa-form" data-qa-form data-conversation-id="${escapeAttribute(
      conversationId,
    )}" data-generation-id="${escapeAttribute(model.generationId)}" ` +
    `data-lesson-id="${escapeAttribute(model.activeLesson?.lesson.lessonId ?? "")}" data-topic-id="${escapeAttribute(model.activeTopic?.topicId ?? "")}" data-topic-draft="${model.activeTopic && !model.activeTopic.lesson ? "true" : "false"}" method="post" action="${action}">` +
    (model.activeTopic && !model.activeTopic.lesson
      ? `<p class="hint">请先在正文区域提交第一个问题，生成主题讲解。</p>`
      : "") +
    `<label for="qa-input">你的问题</label>` +
    `<textarea data-testid="qa-input" id="qa-input" name="text" rows="3" ` +
    `placeholder="针对当前讲解或选中的代码提问"></textarea>` +
    `<input type="hidden" data-qa-selection-source name="selectionSource" value="">` +
    `<input type="hidden" data-qa-selection-source-ids name="selectionSourceIds" value="">` +
    `<input type="hidden" data-qa-selection-commit name="selectionCommit" value="">` +
    `<p data-qa-selection-label class="selection-context" hidden></p><div class="form-actions"><button class="primary" type="submit"${model.generationId === "" || (model.activeTopic && !model.activeTopic.lesson) ? " disabled" : ""}>发送</button><button type="button" class="quiet" data-qa-stop hidden>停止生成</button></div><p data-form-status role="status" aria-live="polite"></p>` +
    `</form>` +
    `</aside>`
  );
}

function renderTopic(model: ReaderPageModel): string {
  const topic = model.activeTopic!;
  const busy = topic.state === "generating";
  return (
    `<article class="reader-lesson learning-topic" data-testid="reader-lesson" data-active-topic="${escapeAttribute(topic.topicId)}" data-topic-state="${topic.state}">
    <header class="lesson-head"><div class="lesson-heading-row"><div><span class="eyebrow">我的学习主题</span><h1>${escapeHtml(topic.displayTitle)}</h1></div><button type="button" class="danger quiet" data-open-dialog="delete-topic"${busy ? " disabled" : ""}>删除主题</button></div><p class="lesson-meta">${escapeHtml(model.repoDisplayName)} · 提交 <code>${shortSha(model.commitSha)}</code></p></header>` +
    (topic.lesson
      ? `<section class="topic-article"><details class="topic-first-question"><summary>最初的问题</summary><p>${escapeHtml(topic.firstQuestion ?? "")}</p></details><div class="lesson-rendered">${renderMarkdownSafe(topic.lesson.content)}</div>${topic.lesson.unknownReason ? `<p class="unknown">${escapeHtml(topic.lesson.unknownReason)}</p>` : ""}${topic.lesson.incomplete ? '<p class="hint">讲解有未覆盖的内容，可继续追问。</p>' : ""}<ul class="message-citations">${topic.lesson.citations.map(citationLink).join("")}</ul><button type="button" class="primary" data-reader-pane="qa">继续追问这个主题</button><p class="hint">讲解已保存。后续追问保存在这个主题的会话中。</p></section>`
      : `<section class="topic-start"><h2>你想了解项目的哪个点？</h2><p>${topic.autoTitle && !topic.title ? "主题名称可以先留空，生成讲解后会根据你的问题自动命名。" : "围绕这个主题提出第一个问题，生成独立学习讲解。"}</p><form data-topic-question data-topic-id="${escapeAttribute(topic.topicId)}"><label for="topic-question">第一个问题</label><textarea id="topic-question" name="text" rows="5" maxlength="16000" required placeholder="例如：这个项目的一次风险评分请求，会经过哪些步骤？"${busy ? " disabled" : ""}>${escapeHtml(topic.firstQuestion ?? "")}</textarea><div class="form-actions"><button type="submit" class="primary"${busy ? " disabled" : ""}>${topic.state === "failed" ? "重新生成讲解" : "生成讲解"}</button><button type="button" class="quiet" data-topic-stop hidden>停止生成</button></div><p data-form-status role="status" aria-live="polite"${topic.error ? ' data-state="error"' : ""}>${escapeHtml(busy ? "正在检索项目证据并生成讲解，完成后自动显示。" : (topic.error ?? "问题会基于当前分析版本的项目文档和代码证据回答。"))}</p></form><div class="topic-draft-preview" data-topic-draft-preview aria-live="polite"></div></section>`) +
    (topic.lesson && topic.error
      ? `<p class="unknown">上次追问未完成：${escapeHtml(topic.error)}。已有讲解保留，可以继续提问。</p>`
      : "") +
    `</article>`
  );
}

function renderLesson(model: ReaderPageModel): string {
  if (model.activeTopic) return renderTopic(model);
  const detail = model.activeLesson;
  const title =
    detail === null
      ? "选择一个讲解"
      : (model.lessons.find((item) => item.lessonId === detail.lesson.lessonId)
          ?.title ?? "项目讲解");
  const diagram = detail === null ? "" : renderDiagram(detail.diagram);
  const readingOffset =
    model.readingPosition === null
      ? ""
      : ` data-reading-position="${String(model.readingPosition.offset)}"`;

  return (
    `<article class="reader-lesson" data-testid="reader-lesson"` +
    `${readingOffset}>` +
    `<header class="lesson-head"><div class="lesson-heading-row"><div><span class="eyebrow">${detail ? "自动生成的学习讲解" : "项目学习"}</span><h1>${escapeHtml(title)}</h1></div>${detail ? `<button type="button" class="danger quiet" data-open-dialog="delete-lesson">删除讲解</button>` : ""}</div>` +
    `<p class="lesson-meta">${escapeHtml(model.repoDisplayName)} · 提交 <code>${shortSha(model.commitSha)}</code></p></header>` +
    (model.generationId === ""
      ? `<section class="empty-state"><h2>这个项目还没有讲解</h2><p>先生成讲解，再从具体流程开始学习。</p><a class="button primary" href="/?project=${escapeAttribute(model.projectId ?? "")}">返回项目开始分析 →</a></section>`
      : detail === null && (model.deletedLessons?.length ?? 0) > 0
        ? `<section class="empty-state"><h2>本版本的讲解已删除</h2><p>可在目录的“已删除的讲解”中恢复，或直接点“追问”询问项目。项目文档和代码证据仍然保留。</p><button type="button" class="primary" data-reader-pane="qa">直接向项目提问</button></section>`
        : renderPlain(model, detail)) +
    diagram +
    `<div${detail ? "" : " hidden"}>` +
    renderTechnical(detail, model.generationId) +
    renderChoices(detail) +
    renderBoundaries(detail) +
    `<details class="lesson-details"><summary>陈述与证据</summary>${renderEvidence(detail, model.generationId)}</details></div>` +
    renderCoverage(model.coverage) +
    `</article>`
  );
}

function renderSource(model: ReaderPageModel): string {
  const source = model.source;
  return `<aside class="source-panel" data-source-panel aria-label="代码证据"${source ? "" : " hidden"}><div class="panel-heading"><h2>代码证据</h2><button type="button" class="quiet" data-reader-close>收起</button></div><p data-source-label>${escapeHtml(source?.label ?? "")}</p><p class="hint" data-source-version>${source ? `提交 ${shortSha(source.commitSha)}${source.lines ? ` · 行 ${source.lines.start}–${source.lines.end}` : ""}` : ""}</p><pre data-source-content><code>${escapeHtml(source?.content ?? "")}</code></pre><p data-source-status role="status">${!source ? "点击正文引用或图中的模块，查看对应代码依据。" : source && source.availability !== "available" ? "来源已不可用" : source?.truncated ? "内容较长，已截断" : ""}</p><button type="button" data-source-ask${source ? "" : " disabled"} data-source-id="${escapeAttribute(source?.sourceId ?? "")}" data-commit-sha="${escapeAttribute(source?.commitSha ?? "")}">针对这段代码追问</button></aside>`;
}

/** Reading first; Q&A and evidence share an on-demand context region. */
export function renderReaderPage(
  ctx: PageContext,
  model: ReaderPageModel,
): string {
  const panel = model.source
    ? "source"
    : model.conversation && !model.activeTopic
      ? "qa"
      : "closed";
  const body =
    `<header class="reader-toolbar"><a href="/">← 我的项目</a>${model.generationId ? `<button type="button" class="primary" data-open-dialog="create-topic">＋ 新建学习主题</button>` : ""}<div class="reader-switch" role="group" aria-label="阅读视图"><button type="button" data-reader-pane="nav">目录</button><button type="button" data-reader-pane="reading" aria-pressed="true">阅读</button><button type="button" data-reader-pane="qa">追问</button><button type="button" data-reader-pane="source">代码证据</button></div></header>` +
    `<div class="reader-grid" data-reader-panel="${panel}" data-generation-id="${escapeAttribute(model.generationId)}" data-lesson-id="${escapeAttribute(model.activeLesson?.lesson.lessonId ?? "")}">` +
    renderNav(model) +
    renderLesson(model) +
    renderQa(model) +
    renderSource(model) +
    `</div>` +
    (model.generationId
      ? `<dialog id="create-topic" class="remove-dialog" aria-labelledby="create-topic-title"><div class="dialog-heading"><h2 id="create-topic-title">新建学习主题</h2><button type="button" class="quiet" data-close-dialog>关闭</button></div><p>为项目中的一个问题创建独立讲解，后续可在主题内持续追问。</p><form data-create-topic data-generation-id="${escapeAttribute(model.generationId)}"><label for="topic-title">主题名称 <span class="hint">（可留空）</span></label><input id="topic-title" name="title" maxlength="80" placeholder="留空，根据第一个问题自动命名"><p class="hint">留空先显示为“未命名主题”，提问后自动总结名称。</p><div class="form-actions"><button type="button" class="quiet" data-close-dialog>取消</button><button type="submit" class="primary">创建主题</button></div><p data-form-status role="status" aria-live="polite"></p></form></dialog>`
      : "") +
    (model.activeTopic
      ? `<dialog id="delete-topic" class="remove-dialog" aria-labelledby="delete-topic-title"><div class="dialog-heading"><h2 id="delete-topic-title">删除这个学习主题？</h2><button type="button" class="quiet" data-close-dialog>关闭</button></div><p>主题讲解和追问记录会保留，可在目录的“已删除的主题”中恢复。</p><form data-delete-topic data-topic-id="${escapeAttribute(model.activeTopic.topicId)}" data-generation-id="${escapeAttribute(model.generationId)}"><div class="form-actions"><button type="button" class="quiet" data-close-dialog>取消</button><button type="submit" class="danger">确认删除主题</button></div><p data-form-status role="status" aria-live="polite"></p></form></dialog>`
      : "") +
    (model.activeLesson
      ? `<dialog id="delete-lesson" class="remove-dialog" aria-labelledby="delete-lesson-title"><div class="dialog-heading"><h2 id="delete-lesson-title">删除这篇讲解？</h2><button type="button" class="quiet" data-close-dialog aria-label="关闭删除确认">关闭</button></div><p>删除后将从当前版本的学习目录移除这篇讲解。项目文档、代码证据和已有追问记录保留；需要时可在“已删除的讲解”中恢复。</p><form data-delete-lesson data-generation-id="${escapeAttribute(model.generationId)}" data-lesson-id="${escapeAttribute(model.activeLesson.lesson.lessonId)}"><div class="form-actions"><button type="button" class="quiet" data-close-dialog>取消</button><button type="submit" class="danger">确认删除讲解</button></div><p data-form-status role="status" aria-live="polite"></p></form></dialog>`
      : "");
  return renderPageShell(
    { ...ctx, projectId: model.projectId },
    "阅读",
    "learn",
    body,
  );
}
