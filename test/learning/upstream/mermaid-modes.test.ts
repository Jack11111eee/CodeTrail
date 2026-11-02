import { describe, expect, test } from "vitest";

import {
  createUpstreamMermaidPort,
} from "../../../src/learning/upstream/mermaid.js";
import type { UpstreamMermaidDeps } from "../../../src/learning/upstream/mermaid.js";
import {
  heuristicError,
  loadMermaid,
} from "../../../src/mermaid/validate.js";

/**
 * Mermaid validation modes (architecture §6.3, AC-LES-11).
 *
 * The authoritative parser is used when mermaid/jsdom are installed; otherwise
 * the conservative upstream heuristic runs and a valid diagram is still
 * accepted (`{ok:true, mode:"heuristic"}`). Only a genuinely broken diagram is
 * rejected, which is what blocks publication.
 */

const VALID_DIAGRAM = "flowchart TD\n  A[Start] --> B[Finish]";
const INVALID_DIAGRAM = "flowchart TD\n  end[Reserved node id]";

/**
 * Simulates the optional peer deps being absent: no parser, and validation
 * falls through to upstream's exported heuristic on the fence body.
 */
function heuristicOnlyDeps(): UpstreamMermaidDeps {
  return {
    loadParser: () => Promise.resolve(undefined),
    findInvalidFences: (markdown) => {
      const lines = markdown.split("\n");
      const body = lines.slice(1, -2).join("\n");
      const message = heuristicError(body);
      return Promise.resolve(message === undefined ? [] : [{ error: message }]);
    },
  };
}

describe("upstream mermaid port", () => {
  test("uses the installed parser when it is available", async () => {
    const parser = await loadMermaid();
    const port = createUpstreamMermaidPort();

    await expect(port.validate(VALID_DIAGRAM)).resolves.toEqual({
      ok: true,
      mode: parser === undefined ? "heuristic" : "strict",
    });
  });

  test("report strict mode only when the parser is present", async () => {
    if ((await loadMermaid()) === undefined) return;
    const port = createUpstreamMermaidPort();

    await expect(port.validate(VALID_DIAGRAM)).resolves.toEqual({
      ok: true,
      mode: "strict",
    });
  });

  test("falls back to heuristic mode without the optional parser", async () => {
    const port = createUpstreamMermaidPort(heuristicOnlyDeps());

    await expect(port.validate(VALID_DIAGRAM)).resolves.toEqual({
      ok: true,
      mode: "heuristic",
    });
  });

  test("the heuristic rejects a clearly broken diagram", async () => {
    const port = createUpstreamMermaidPort(heuristicOnlyDeps());
    const result = await port.validate(INVALID_DIAGRAM);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/reserved word/u);
    }
  });

  test("a genuinely invalid diagram is rejected", async () => {
    const port = createUpstreamMermaidPort();
    const result = await port.validate(INVALID_DIAGRAM);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
