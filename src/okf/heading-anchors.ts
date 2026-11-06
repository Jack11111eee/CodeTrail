import { marked, type Token, type Tokens } from "marked";

/**
 * GitHub-compatible heading anchors for Markdown pages.
 *
 * This mirrors the private parser in the pinned upstream `src/retrieval/wiki.ts`
 * so the learning module can resolve immutable wiki citations without importing
 * an upstream module. Keep the two implementations in sync: an anchor change
 * here must match what search/read produce.
 */
/**
 * Readable anchor for the heading whose GitHub slug is empty, such as `## 🚀`.
 */
const SYMBOL_ONLY_HEADING_ANCHOR = "section";

/**
 * One parsed Markdown heading and its complete descendant-bounded section.
 */
export interface ParsedHeadingSection {
  /**
   * GitHub-compatible heading anchor, including duplicate suffixes.
   */
  anchor: string;

  /**
   * Markdown heading depth.
   */
  depth: number;

  /**
   * Human-readable heading text.
   */
  heading: string;

  /**
   * Complete raw Markdown for the heading and its descendants.
   */
  raw: string;
}

/**
 * One parsed heading plus its token-array location.
 */
interface LocatedHeading {
  /**
   * GitHub-compatible heading anchor, including duplicate suffixes.
   */
  anchor: string;

  /**
   * Markdown heading depth.
   */
  depth: number;

  /**
   * Human-readable heading text.
   */
  heading: string;

  /**
   * Token-array position of the heading.
   */
  index: number;
}

/**
 * Parses every heading using duplicate anchors compatible with GitHub slugs.
 *
 * @param tokens - Tokenized Markdown page body.
 * @returns Parsed headings with descendant-bounded raw Markdown.
 */
export function headingSections(tokens: Token[]): ParsedHeadingSection[] {
  const headings: LocatedHeading[] = [];
  // GitHub's slugger advances a numeric suffix only until the *candidate* anchor is
  // free, so a heading whose own slug was already taken by an earlier generated
  // suffix keeps probing instead of reusing that anchor. Multiplicity matters because
  // both readWikiSections and searchWiki key sections by anchor: a repeated anchor
  // silently drops one section from the lookup map and hands the surviving search
  // reference the wrong section's body.
  const suffixes = new Map<string, number>();
  const taken = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "heading") continue;
    const heading = token as Tokens.Heading;
    const base = headingSlug(heading);
    let anchor = base;
    let suffix = suffixes.get(base) ?? 0;
    while (taken.has(anchor)) {
      suffix += 1;
      anchor = `${base}-${suffix}`;
    }
    suffixes.set(base, suffix);
    taken.add(anchor);
    headings.push({
      anchor,
      depth: heading.depth,
      heading: heading.text,
      index,
    });
  }
  // A symbol-only heading slugs to "", which read rejects; alias it without displacing any GitHub anchor.
  const unaddressable = headings.find(({ anchor }) => !anchor);
  if (unaddressable) {
    let fallback = SYMBOL_ONLY_HEADING_ANCHOR;
    for (let suffix = 1; taken.has(fallback); suffix += 1) {
      fallback = `${SYMBOL_ONLY_HEADING_ANCHOR}-${suffix}`;
    }
    unaddressable.anchor = fallback;
  }
  return headings.map((heading) => {
    let end = heading.index + 1;
    while (end < tokens.length) {
      const next = tokens[end];
      if (
        next?.type === "heading" &&
        (next as Tokens.Heading).depth <= heading.depth
      ) {
        break;
      }
      end += 1;
    }
    return {
      anchor: heading.anchor,
      depth: heading.depth,
      heading: heading.heading,
      raw: tokens
        .slice(heading.index, end)
        .map((token) => token.raw)
        .join("")
        .trim(),
    };
  });
}

/**
 * Produces the GitHub-compatible base anchor for one Markdown heading.
 *
 * @param heading - Parsed Markdown heading.
 * @returns Lowercase anchor before duplicate suffixing.
 */
function headingSlug(heading: Tokens.Heading): string {
  return inlineHeadingText(heading.tokens)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/ /gu, "-");
}

/**
 * Extracts visible heading text without retaining raw HTML tokens.
 *
 * @param tokens - Parsed inline heading tokens.
 * @returns Concatenated textual content used to form an anchor.
 */
function inlineHeadingText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "html") return "";
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return inlineHeadingText(token.tokens);
      }
      if ("text" in token && typeof token.text === "string") {
        return token.text;
      }
      return token.type === "br" ? " " : "";
    })
    .join("");
}

/** The same heading anchors used by search/read, for immutable citation lookup. */
export function wikiHeadingAnchors(markdown: string): string[] {
  return headingSections(marked.lexer(markdown)).map(
    (section) => section.anchor,
  );
}
