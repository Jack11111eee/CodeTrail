/**
 * Markdown rendering and the sanitising allowlist (architecture §16.3,
 * AC-SEC-06).
 *
 * Lesson bodies, README excerpts and QA answers are repository text: they are
 * data, never markup. `marked` turns the Markdown into HTML and the small
 * allowlist pass below removes everything a browser could execute:
 *
 *   - `script`, `iframe`, `object`, `embed`, `style`, `svg` and `math` are
 *     dropped together with their contents;
 *   - every `on*=` attribute is dropped;
 *   - `javascript:`, `vbscript:`, `data:` and `file:` URLs are dropped;
 *   - `<img>` sources must be same-origin/relative (CSP also blocks remote
 *     images, but the page must not even carry the origin).
 *
 * The implementation deliberately has no DOM, no DOMPurify and no jsdom: the
 * sanitizer runs in the server process and its output is a plain string.
 *
 * Mermaid is never executed. A fenced ```mermaid block is either removed
 * (`allowMermaidCodeBlocks:false`) or kept as escaped, inert text.
 */

import { marked } from "marked";

export interface SanitizeOptions {
  allowMermaidCodeBlocks: boolean;
}

/** Tags Markdown may legitimately produce. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Tags whose entire content is untrusted executable/foreign content. */
const SKIP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  "button",
  "embed",
  "form",
  "iframe",
  "math",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
]);

/**
 * Void elements that must be dropped *without* swallowing the following
 * content. GFM task lists render `<input type="checkbox">`, which has no
 * closing tag; treating it like a container would delete the item text and
 * everything after it.
 */
const VOID_SKIP_TAGS: ReadonlySet<string> = new Set([
  "base",
  "input",
  "link",
  "meta",
]);

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img"]);

const GLOBAL_ATTRS: ReadonlySet<string> = new Set([
  "class",
  "dir",
  "lang",
  "role",
  "title",
  "aria-hidden",
  "aria-label",
]);

const TAG_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  img: ["src", "alt", "width", "height"],
  ol: ["start"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  code: ["class"],
  details: ["open"],
};

const SAFE_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

const MERMAID_BLOCK =
  /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/giu;

/** Escape text for an HTML text node, preserving existing character entities. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);)/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** Escape a value for a double-quoted HTML attribute. `>` is safe here. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);)/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/"/gu, "&quot;");
}

interface ParsedAttribute {
  name: string;
  value: string;
}

interface ParsedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: ParsedAttribute[];
  end: number;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * Reads one tag starting at `start` (which must be `<`). Returns `null` for a
 * sequence that is not a tag; the caller then escapes the `<` as text.
 */
function parseTag(html: string, start: number): ParsedTag | null {
  let index = start + 1;
  let closing = false;
  if (html[index] === "/") {
    closing = true;
    index += 1;
  }

  const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(html.slice(index));
  if (nameMatch === null) return null;
  const name = nameMatch[0].toLowerCase();
  index += nameMatch[0].length;

  const attributes: ParsedAttribute[] = [];
  const selfClosing = false;

  while (index < html.length) {
    while (index < html.length && isWhitespace(html[index])) index += 1;
    if (index >= html.length) break;

    if (html[index] === ">") {
      return { name, closing, selfClosing, attributes, end: index + 1 };
    }
    if (html[index] === "/" && html[index + 1] === ">") {
      return { name, closing, selfClosing: true, attributes, end: index + 2 };
    }

    const attrMatch = /^[^\s=/>]+/u.exec(html.slice(index));
    if (attrMatch === null) {
      index += 1;
      continue;
    }
    const attrName = attrMatch[0].toLowerCase();
    index += attrMatch[0].length;

    while (index < html.length && isWhitespace(html[index])) index += 1;

    let value = "";
    if (html[index] === "=") {
      index += 1;
      while (index < html.length && isWhitespace(html[index])) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const closeQuote = html.indexOf(quote, index);
        if (closeQuote === -1) {
          value = html.slice(index);
          index = html.length;
        } else {
          value = html.slice(index, closeQuote);
          index = closeQuote + 1;
        }
      } else {
        const valueMatch = /^[^\s>]*/u.exec(html.slice(index));
        value = valueMatch === null ? "" : valueMatch[0];
        index += value.length;
      }
    }

    attributes.push({ name: attrName, value });
  }

  // Unterminated tag: treat the rest as text rather than inventing markup.
  return null;
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, hex: string) =>
      codePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_, dec: string) =>
      codePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&colon;/giu, ":")
    .replace(/&tab;/giu, "\t")
    .replace(/&newline;/giu, "\n")
    .replace(/&amp;/giu, "&");
}

function normalizeUrl(value: string): string {
  const decoded = decodeEntities(value);
  let out = "";
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || /\s/u.test(char)) continue;
    out += char;
  }
  return out.toLowerCase();
}

function hasDangerousScheme(value: string): boolean {
  const normalized = normalizeUrl(value);
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("file:")
  );
}

/** Relative, root-relative and fragment URLs only for `src`. */
function isSafeImageSource(value: string): boolean {
  if (hasDangerousScheme(value)) return false;
  const normalized = normalizeUrl(value);
  if (normalized === "") return false;
  // A protocol-relative URL or any explicit scheme would leave this origin.
  if (normalized.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(normalized);
}

function isSafeHref(value: string): boolean {
  if (hasDangerousScheme(value)) return false;
  const normalized = normalizeUrl(value);
  if (normalized === "") return false;
  if (normalized.startsWith("//")) return false; // protocol-relative leaves this origin
  const scheme = /^([a-z][a-z0-9+.-]*:)/iu.exec(normalized);
  if (scheme === null) return true;
  return SAFE_SCHEMES.has(scheme[1]);
}

function isAllowedAttribute(tag: string, name: string): boolean {
  if (name.startsWith("on")) return false;
  if (name === "style" || name === "srcdoc" || name === "formaction") {
    return false;
  }
  if (GLOBAL_ATTRS.has(name)) return true;
  return (TAG_ATTRS[tag] ?? []).includes(name);
}

function renderAttributes(tag: string, attributes: ParsedAttribute[]): string {
  const seen = new Set<string>();
  let out = "";
  for (const attribute of attributes) {
    if (seen.has(attribute.name)) continue;
    seen.add(attribute.name);
    if (!isAllowedAttribute(tag, attribute.name)) continue;

    if (attribute.name === "href" && !isSafeHref(attribute.value)) continue;
    if (attribute.name === "src" && !isSafeImageSource(attribute.value)) {
      continue;
    }

    out += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`;
  }
  return out;
}

function skipToClosingTag(html: string, name: string, from: number): number {
  const pattern = new RegExp(`</\\s*${name}\\s*>`, "iu");
  const rest = html.slice(from);
  const match = pattern.exec(rest);
  if (match === null) return html.length;
  return from + match.index + match[0].length;
}

/**
 * Sanitises an HTML string against the tag/attribute allowlist. Unknown tags
 * are unwrapped (their text survives); executable/foreign tags are removed
 * with their content.
 */
export function sanitizeHtml(html: string, opts: SanitizeOptions): string {
  if (typeof html !== "string" || html === "") return "";

  let out = "";
  let index = 0;
  const open: string[] = [];

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      out += escapeHtml(html.slice(index));
      break;
    }

    if (lt > index) out += escapeHtml(html.slice(index, lt));

    // Comments, doctypes and processing instructions never survive.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = parseTag(html, lt);
    if (tag === null) {
      out += "&lt;";
      index = lt + 1;
      continue;
    }
    index = tag.end;

    if (tag.closing) {
      if (!ALLOWED_TAGS.has(tag.name) || VOID_TAGS.has(tag.name)) continue;
      const at = open.lastIndexOf(tag.name);
      if (at === -1) continue;
      while (open.length > at) {
        out += `</${open.pop() as string}>`;
      }
      continue;
    }

    // A void element has no content of its own: drop the tag only, so the
    // following text (a task-list item, say) survives.
    if (VOID_SKIP_TAGS.has(tag.name)) continue;
    if (SKIP_CONTENT_TAGS.has(tag.name)) {
      index = skipToClosingTag(html, tag.name, index);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag.name)) continue;

    const attributes = renderAttributes(tag.name, tag.attributes);
    if (VOID_TAGS.has(tag.name)) {
      out += `<${tag.name}${attributes}>`;
      continue;
    }
    out += `<${tag.name}${attributes}>`;
    open.push(tag.name);
  }

  while (open.length > 0) out += `</${open.pop() as string}>`;

  if (!opts.allowMermaidCodeBlocks) {
    out = out.replace(MERMAID_BLOCK, "");
  }
  return out;
}

/**
 * Secondary defence for already-rendered HTML: removes dangerous tags,
 * event-handler attributes and executable URLs while leaving safe markup.
 */
export function stripDangerousLinks(html: string): string {
  return html
    .replace(
      /<\s*(script|iframe|object|embed|style|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu,
      "",
    )
    .replace(
      /<\s*(script|iframe|object|embed|style|svg|math)\b[^>]*\/?\s*>/giu,
      "",
    )
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(
      /\b(href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data|file):[^"]*"|'\s*(?:javascript|vbscript|data|file):[^']*'|(?:javascript|vbscript|data|file):[^\s>]*)/giu,
      '$1="#"',
    );
}

/** Renders Markdown to sanitised HTML. Mermaid fences remain inert text. */
export function renderMarkdown(markdown: string): string {
  return renderMarkdownSafe(markdown);
}

/** Alias with an explicit name for call sites that emphasise safety. */
export function renderMarkdownSafe(markdown: string): string {
  const rendered = marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: false,
  });
  const html = typeof rendered === "string" ? rendered : "";
  return sanitizeHtml(html, { allowMermaidCodeBlocks: true });
}
