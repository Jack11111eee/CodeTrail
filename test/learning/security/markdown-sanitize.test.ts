import { describe, expect, it } from "vitest";

import {
  renderMarkdown,
  renderMarkdownSafe,
  sanitizeHtml,
  stripDangerousLinks,
} from "../../../src/learning/ui/render/markdown.ts";
import { renderInboxPage } from "../../../src/learning/ui/pages/inbox.ts";
import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";
import { renderTermsPage } from "../../../src/learning/ui/pages/terms.ts";
import {
  changeSummary,
  conversation,
  inboxModel,
  lessonDetail,
  message,
  pageContext,
  projectsModel,
  projectSummary,
  readerModel,
  researchLesson,
  settingsModel,
  termsModel,
  termView,
} from "../ui/fixtures.ts";

/**
 * AC-SEC-06: repository text is data. Scripts, event attributes, executable
 * URLs and iframes are removed; Mermaid source stays inert text.
 */

describe("markdown sanitizer", () => {
  it("removes script tags and their content", () => {
    const html = renderMarkdown("# hi\n\n<script>alert('x')</script>\n\nbye");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script");
    expect(html).not.toContain("alert");
    expect(html).toContain("hi");
    expect(html).toContain("bye");
  });

  it("removes event-handler attributes", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert");
    expect(html).toContain("<img");
  });

  it("removes javascript: URLs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert");
    expect(html).toContain("click");
  });

  it("removes entity-encoded javascript: URLs", () => {
    const html = sanitizeHtml('<a href="javascript&#58;alert(1)">click</a>', {
      allowMermaidCodeBlocks: true,
    });
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("alert");
    expect(html).toContain("click");
  });

  it("removes iframes and their contents", () => {
    const html = renderMarkdown(
      '<iframe src="https://evil.example/x"></iframe>',
    );
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("evil.example");
  });

  it("removes foreign/executable containers such as svg and object", () => {
    const html = sanitizeHtml(
      '<svg><script>alert(1)</script></svg><object data="x"></object>',
      { allowMermaidCodeBlocks: true },
    );
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("alert");
  });

  it("keeps task-list text when dropping the checkbox input", () => {
    const html = renderMarkdown("- [ ] first item\n- [x] second item");
    expect(html).not.toContain("<input");
    expect(html).toContain("first item");
    expect(html).toContain("second item");
  });

  it("keeps Mermaid source as inert text", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");
    expect(html).toContain("language-mermaid");
    expect(html).toContain("graph TD");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("mermaid.initialize");
  });

  it("can remove Mermaid code blocks entirely", () => {
    const html = sanitizeHtml(
      '<pre><code class="language-mermaid">graph TD</code></pre>',
      { allowMermaidCodeBlocks: false },
    );
    expect(html).not.toContain("graph TD");
    expect(html).not.toContain("language-mermaid");
  });

  it("preserves safe Markdown and existing entities", () => {
    const html = renderMarkdownSafe("**bold** and A & B");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("&amp;amp;");
  });

  it("strips dangerous links from already-rendered HTML", () => {
    const html = stripDangerousLinks(
      '<a href="javascript:alert(1)" onclick="x()">go</a>' +
        "<script>alert(2)</script>",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    expect(html).toContain("go");
  });

  it("sanitises an active lesson's rendered HTML on the reader", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({
        activeLesson: lessonDetail("component", {
          html:
            '<p>safe</p><script>alert("lesson")</script>' +
            '<iframe src="https://evil.example"></iframe>',
        }),
      }),
    );
    expect(html).toContain("safe");
    // The shell's own deferred module script is allowed; the lesson payload
    // cannot add another script element or an iframe.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
    expect(html).not.toContain('alert("lesson")');
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("evil.example");
  });
});

describe("sanitizer bypass variants", () => {
  const opts = { allowMermaidCodeBlocks: true };

  it("removes case-varied executable containers", () => {
    const html = sanitizeHtml(
      "<SCRIPT>alert(1)</SCRIPT><ScRiPt>alert(2)</sCrIpT>" +
        "<IFRAME src=x>inner</IFRAME><OBJECT data=x></OBJECT>",
      opts,
    );
    expect(html).not.toContain("alert");
    expect(html).not.toContain("inner");
  });

  it("removes whitespace- and entity-encoded javascript: URLs", () => {
    for (const href of [
      "jav\tascript:alert(1)",
      "java\nscript:alert(1)",
      "&#x6a;avascript:alert(1)",
      "&#106;avascript:alert(1)",
      "javascript&#58;alert(1)",
    ]) {
      const html = sanitizeHtml(`<a href="${href}">x</a>`, opts);
      expect(html, href).toBe("<a>x</a>");
    }
  });

  it("removes non-web schemes from links", () => {
    for (const href of [
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "blob:https://evil.example/x",
      "//evil.example/x",
    ]) {
      const html = sanitizeHtml(`<a href="${href}">x</a>`, opts);
      expect(html, href).toBe("<a>x</a>");
    }
  });

  it("removes remote, protocol-relative and data image sources", () => {
    const html = sanitizeHtml(
      '<img src="https://evil.example/x.png" alt="a">' +
        '<img src="//evil.example/y.png" alt="b">' +
        '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="c">',
      opts,
    );
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("data:");
    expect(html).not.toContain("onload");
    expect(html).toContain('<img alt="a">');
    expect(html).toContain('<img alt="b">');
    expect(html).toContain('<img alt="c">');
  });

  it("removes srcdoc, formaction and style attributes", () => {
    const html = sanitizeHtml(
      '<p style="background:url(javascript:alert(1))">x</p>' +
        '<iframe srcdoc="<script>alert(2)</script>">y</iframe>' +
        '<form action="/x"><button formaction="javascript:alert(3)">b</button></form>',
      opts,
    );
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("formaction");
    expect(html).toContain("<p>x</p>");
  });

  it("sanitises assistant answers rendered on the reader", () => {
    const html = renderReaderPage(
      pageContext,
      readerModel({
        conversation: conversation({
          messages: [
            message({
              role: "assistant",
              content:
                '安全 <script>alert("answer")</script>' +
                '<iframe src="https://evil.example"></iframe>',
            }),
          ],
        }),
      }),
    );
    expect(html).toContain("安全");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
    expect(html).not.toContain('alert("answer")');
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("evil.example");
  });
});

describe("repository text and page shells", () => {
  const payload = '<script>alert("repo")</script>';

  it("escapes repository-controlled text on every page", () => {
    const pages = [
      renderProjectsPage(
        pageContext,
        projectsModel({
          projects: [
            projectSummary({
              displayName: payload,
              defaultBranch: payload,
            }),
          ],
        }),
      ),
      renderReaderPage(
        pageContext,
        readerModel({
          activeLesson: lessonDetail("component", {
            lesson: researchLesson({
              statements: [
                {
                  id: "st_escape",
                  label: "code_fact",
                  text: payload,
                  evidenceIds: [],
                },
              ],
            }),
          }),
        }),
      ),
      renderInboxPage(
        pageContext,
        inboxModel({ items: [changeSummary({ title: payload })] }),
      ),
      renderTermsPage(
        pageContext,
        termsModel({ terms: [termView({ zh: payload, en: payload })] }),
      ),
    ];

    for (const html of pages) {
      expect(html).not.toContain(payload);
      expect(html).toContain("&lt;script&gt;");
    }
  });

  it("never emits an inline script or a non-self asset origin", () => {
    const pages = [
      renderProjectsPage(pageContext, projectsModel()),
      renderReaderPage(pageContext, readerModel()),
      renderInboxPage(pageContext, inboxModel()),
      renderTermsPage(pageContext, termsModel()),
      renderSettingsPage(pageContext, settingsModel()),
    ];

    for (const html of pages) {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
      // Asset references must stay same-origin; the GitHub form placeholder is
      // the only allowed absolute URL and it is never fetched.
      expect(html).not.toMatch(/(?:href|src)="https?:\/\//u);
      expect(html).toContain('href="/assets/styles.css"');
      expect(html).toContain('src="/assets/client.js"');
    }
  });

  it("ignores an external or protocol-relative asset base", () => {
    for (const assetBase of [
      "https://cdn.example/assets",
      "//cdn.example/assets",
      "cdn.example/assets",
      "javascript:alert(1)",
      "",
    ]) {
      const html = renderProjectsPage(
        { dataRoot: "/tmp/codetrail-test", assetBase },
        projectsModel(),
      );
      expect(html, assetBase).not.toContain("cdn.example");
      expect(html, assetBase).not.toContain("javascript");
      expect(html, assetBase).toContain('href="/assets/styles.css"');
      expect(html, assetBase).toContain('src="/assets/client.js"');
    }
  });

  it("keeps a safe same-origin asset base", () => {
    const html = renderProjectsPage(
      { dataRoot: "/tmp/codetrail-test", assetBase: "/static/" },
      projectsModel(),
    );
    expect(html).toContain('href="/static/styles.css"');
    expect(html).toContain('src="/static/client.js"');
  });
});
