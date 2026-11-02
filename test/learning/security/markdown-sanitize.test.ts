import { describe, expect, it } from "vitest";

import {
  renderMarkdown,
  renderMarkdownSafe,
  sanitizeHtml,
  stripDangerousLinks,
} from "../../../src/learning/ui/render/markdown.ts";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { lessonDetail, pageContext, readerModel } from "../ui/fixtures.ts";

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
