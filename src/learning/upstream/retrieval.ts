/**
 * The upstream retrieval port (read side, architecture §6.3).
 *
 * A `PublishedWikiRef` names a sealed knowledge directory, so this port only
 * ever reads it. Upstream's `ref` strings (`openwiki/x.md#anchor`) are converted
 * into `{page, anchor}` pairs here; callers never see an upstream shape.
 */

import { ClaimsStore } from "../../claims/brains/code/store.js";
import { readFrontmatterField } from "../../okf/frontmatter.js";
import { readWikiSections, searchWiki } from "../../retrieval/wiki.js";
import type {
  PublishedWikiRef,
  UpstreamRetrievalPort,
  WikiHit,
  WikiSectionResult,
} from "../contracts/index.js";
import { mapUpstreamError } from "./generation.js";

// Declared in contracts/upstream.ts (§3.15); re-export only.
export type { WikiHit, WikiSectionResult, UpstreamRetrievalPort };

/** Splits `openwiki/x.md#anchor` on the first `#`; a missing anchor is "". */
export function splitWikiRef(reference: string): {
  page: string;
  anchor: string;
} {
  const fragment = reference.indexOf("#");
  const rawPage = fragment === -1 ? reference : reference.slice(0, fragment);
  const anchor = fragment === -1 ? "" : reference.slice(fragment + 1);
  return { page: rawPage.replace(/^\/+/u, ""), anchor };
}

/** Implements `UpstreamRetrievalPort` (§3.15, §6.3). */
export function createUpstreamRetrievalPort(): UpstreamRetrievalPort {
  const titleCache = new Map<string, string>();

  async function titleOf(knowledgeDir: string, page: string): Promise<string> {
    const cacheKey = `${knowledgeDir}\0${page}`;
    const cached = titleCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let title = page;
    try {
      const markdown = await new ClaimsStore(knowledgeDir).readMarkdown(page);
      const declared = readFrontmatterField(markdown, "title")?.trim();
      if (declared !== undefined && declared !== "") title = declared;
    } catch {
      // A title is display data; the page path is always a usable fallback.
    }
    titleCache.set(cacheKey, title);
    return title;
  }

  return {
    async search(
      ref: PublishedWikiRef,
      query: string,
      hints?: string[],
      limit?: number,
    ): Promise<WikiHit[]> {
      try {
        const response = await searchWiki(ref.knowledgeDir, {
          query,
          ...(hints === undefined ? {} : { paths: hints }),
          ...(limit === undefined ? {} : { limit }),
        });
        // A standalone knowledge directory can never be an ambiguous workspace.
        if ("status" in response) return [];

        const hits: WikiHit[] = [];
        for (const result of response.results) {
          const first = result.ref[0];
          if (first === undefined) continue;
          const { page, anchor } = splitWikiRef(first);
          if (page === "") continue;
          hits.push({
            page,
            anchor,
            title: await titleOf(ref.knowledgeDir, page),
            preview: result.content,
          });
        }
        return hits;
      } catch (error) {
        mapUpstreamError(error);
      }
    },

    async readSections(
      ref: PublishedWikiRef,
      page: string,
      anchors: string[],
    ): Promise<WikiSectionResult[]> {
      try {
        const response = await readWikiSections(ref.knowledgeDir, {
          page,
          sections: anchors,
        });
        return response.sections.map((section) => ({
          page: response.page,
          anchor: section.section,
          content: section.content,
        }));
      } catch (error) {
        mapUpstreamError(error);
      }
    },

    async pageTitle(ref: PublishedWikiRef, page: string): Promise<string> {
      return titleOf(ref.knowledgeDir, page);
    },
  };
}
