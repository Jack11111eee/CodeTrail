// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import {
  HEAD_SHA,
  SOURCE_ID,
  diagram,
  lessonDetail,
  pageContext,
  readerModel,
  researchLesson,
} from "./fixtures.ts";

/**
 * AC-UI-04: the progressive-enhancement bundle copies a clicked node's
 * evidence ids and its bound commit into the QA form's hidden fields and into
 * the request body. The server-rendered attributes alone do not prove the
 * click is wired, so this suite drives the only DOM file against a real reader
 * document.
 */
function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

function renderIntoDocument(html: string): void {
  document.open();
  document.write(html);
  document.close();
}

/** A reader whose first node binds two evidence ids. */
function multiEvidenceModel() {
  const base = researchLesson();
  const nodes = [
    { ...base.diagram.nodes[0], evidenceIds: [SOURCE_ID, "s_second"] },
    base.diagram.nodes[1],
  ];
  const lesson = {
    ...base,
    diagram: { ...base.diagram, nodes },
  };
  return readerModel({
    activeLesson: lessonDetail("component", {
      lesson,
      diagram: diagram("component", { nodes }),
    }),
  });
}

describe("diagram selection client", () => {
  beforeEach(() => {
    // `client.ts` wires itself on import; reset so each test gets fresh
    // listeners against its own document.
    vi.resetModules();
  });

  it("submits the clicked node's evidence and bound commit", async () => {
    const html = renderReaderPage(pageContext, readerModel());
    renderIntoDocument(html);

    // The bundle wires itself on import; the DOM must exist first.
    await import("../../../src/learning/ui/client.ts");

    expect(countTestId(document.body.innerHTML, "reader-qa")).toBe(1);

    const source = document.querySelector<HTMLInputElement>(
      "[data-qa-selection-source]",
    );
    const sourceIds = document.querySelector<HTMLInputElement>(
      "[data-qa-selection-source-ids]",
    );
    const commit = document.querySelector<HTMLInputElement>(
      "[data-qa-selection-commit]",
    );

    const first = document.querySelector<SVGGElement>('[data-node-id="n1"]');
    expect(first).not.toBeNull();
    first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(source?.value).toBe("s_0123456789abcdef");
    expect(sourceIds?.value).toBe("s_0123456789abcdef");
    expect(commit?.value).toBe(HEAD_SHA);
    expect(first?.getAttribute("aria-pressed")).toBe("true");

    // A second click replaces the selection; the commit never changes because
    // every node carries the generation's bound commit.
    const second = document.querySelector<SVGGElement>('[data-node-id="n2"]');
    second?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(source?.value).toBe("s_second");
    expect(sourceIds?.value).toBe("s_second");
    expect(commit?.value).toBe(HEAD_SHA);
    expect(second?.getAttribute("aria-pressed")).toBe("true");
    expect(first?.getAttribute("aria-pressed")).toBe("false");
  });

  it("posts every evidence id and the bound commit in the selection", async () => {
    const html = renderReaderPage(pageContext, multiEvidenceModel());
    renderIntoDocument(html);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await import("../../../src/learning/ui/client.ts");

    const first = document.querySelector<SVGGElement>('[data-node-id="n1"]');
    first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='qa-input']",
    );
    const form = document.querySelector<HTMLFormElement>("[data-qa-form]");
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();
    if (input !== null) input.value = "为什么这样实现？";
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/conversations/c_0123456789abcdef/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      text: "为什么这样实现？",
      selection: {
        sourceId: "s_0123456789abcdef",
        sourceIds: ["s_0123456789abcdef", "s_second"],
        commitSha: HEAD_SHA,
      },
    });

    vi.unstubAllGlobals();
  });
});
