import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { splitFrontmatter } from "../../okf/frontmatter.js";
import { wikiHeadingAnchors } from "../../retrieval/wiki.js";
import { sourceIdOf } from "../contracts/index.js";
import type { GenerationId, SourceId } from "../contracts/index.js";

/** Synthetic wiki IDs are bound to a sealed generation, never arbitrary paths. */
export function readWikiCitation(
  knowledgeDir: string,
  generationId: GenerationId,
  sourceId: SourceId,
): { label: string; content: string } | null {
  let root: string, files: string[];
  try {
    root = realpathSync(path.join(knowledgeDir, "openwiki"));
    files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (name) => name.endsWith(".md"),
    );
  } catch {
    return null;
  }
  for (const file of files) {
    let content: string;
    try {
      const absolute = realpathSync(path.join(root, file));
      if (!absolute.startsWith(`${root}${path.sep}`)) continue;
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const relative = file.replace(/\\/gu, "/");
    // Tool reads use a bare page stem; upstream retrieval uses openwiki/x.md.
    const pages = new Set([
      relative.replace(/\.md$/u, ""),
      relative,
      `openwiki/${relative}`,
    ]);
    const body = splitFrontmatter(content).body;
    const anchors = ["", ...wikiHeadingAnchors(body)];
    for (const page of pages)
      for (const anchor of anchors) {
        if (
          sourceIdOf("repo", `wiki\0${generationId}\0${page}\0${anchor}`) ===
          sourceId
        )
          return {
            label: `openwiki/${relative}${anchor ? `#${anchor}` : ""}`,
            content: body,
          };
      }
  }
  return null;
}
