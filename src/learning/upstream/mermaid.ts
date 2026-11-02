/**
 * The upstream mermaid port (build side, architecture §6.3).
 *
 * Upstream validates a whole document; the lesson layer validates one diagram,
 * so the diagram is wrapped in a fence before it reaches
 * `findInvalidMermaidFences`. When mermaid/jsdom are not installed the upstream
 * heuristic runs instead and the result is reported as `mode: "heuristic"`; a
 * valid diagram is never blocked by an unavailable parser (PRD §7).
 */

import {
  findInvalidMermaidFences,
  loadMermaid,
} from "../../mermaid/validate.js";
import type { UpstreamMermaidPort } from "../contracts/index.js";

// Declared in contracts/upstream.ts (§3.15); re-export only.
export type { UpstreamMermaidPort };

/** Parser handle; only its presence matters to this port. */
export type MermaidParser = unknown;

export interface UpstreamMermaidDeps {
  /** Overrides the optional-parser probe (tests simulate absent peer deps). */
  loadParser?: () => Promise<MermaidParser>;
  /** Overrides document validation (tests pair this with `loadParser`). */
  findInvalidFences?: (markdown: string) => Promise<{ error: string }[]>;
}

/** Wraps one diagram body so upstream's fence scanner can see it. */
export function asFencedDocument(diagram: string): string {
  return ["```mermaid", diagram, "```", ""].join("\n");
}

/** Implements `UpstreamMermaidPort` (§3.15, §6.3). */
export function createUpstreamMermaidPort(
  deps: UpstreamMermaidDeps = {},
): UpstreamMermaidPort {
  const loadParser = deps.loadParser ?? loadMermaid;
  const findInvalid = deps.findInvalidFences ?? findInvalidMermaidFences;

  return {
    async validate(diagram: string) {
      const parser = await loadParser();
      const errors = await findInvalid(asFencedDocument(diagram));
      if (errors.length > 0) {
        return { ok: false, message: errors[0].error };
      }
      return {
        ok: true,
        mode: parser === undefined ? "heuristic" : "strict",
      };
    },
  };
}
