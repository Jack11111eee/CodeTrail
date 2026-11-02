/**
 * The upstream graph port (read side, architecture §6.3).
 *
 * Upstream's graph is node/edge-shaped for the visualizer; the contract view is
 * a flat `{id,label,page,kind}` / `{from,to,label}` pair. This module converts
 * the one into the other so no visualizer type leaks past the adapter.
 */

import path from "node:path";

import { buildGraph } from "../../visualize/graph.js";
import type {
  PublishedWikiRef,
  UpstreamGraphPort,
  WikiGraph,
} from "../contracts/index.js";
import { mapUpstreamError } from "./generation.js";

// Declared in contracts/refs.ts (§3.9) and contracts/upstream.ts (§3.15).
export type { WikiGraph, UpstreamGraphPort };

/** Implements `UpstreamGraphPort` (§3.15, §6.3). */
export function createUpstreamGraphPort(): UpstreamGraphPort {
  return {
    async graph(ref: PublishedWikiRef): Promise<WikiGraph> {
      try {
        const upstream = await buildGraph(
          path.join(ref.knowledgeDir, "openwiki"),
        );
        return {
          nodes: upstream.nodes.map((node) => ({
            id: node.id,
            label: node.title,
            page: `/openwiki/${node.id}.md`,
            kind: node.type,
          })),
          edges: upstream.edges.map((edge) => ({
            from: edge.source,
            to: edge.target,
            label: "",
          })),
          generatedAt: upstream.generatedAt,
        };
      } catch (error) {
        mapUpstreamError(error);
      }
    },
  };
}
