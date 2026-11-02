/**
 * Language coverage (architecture §5.6).
 *
 * `languageOf` (in `scope.ts`) labels a file. Vue single-file components are
 * split into their `<script>`, `<template>` and `<style>` blocks so evidence
 * can cite the exact 1-based line range. Every language outside
 * `PREFERRED_LANGUAGES` is marked best-effort (AC-PRJ-17): the coverage report
 * and any lesson referencing such a file must carry `best_effort_language`.
 */

import { PREFERRED_LANGUAGES } from "../config/defaults.js";
import { languageOf } from "./scope.js";
import type { LanguageId, LanguageReport } from "../contracts/index.js";

export type { LanguageId, LanguageReport };

export type VueRegion = "script" | "template" | "style";

/** One top-level Vue block; line numbers are 1-based and point at content. */
export interface VueBlock {
  kind: VueRegion;
  startLine: number;
  endLine: number;
  attrs: Record<string, string>;
}

export interface EvidenceSlice {
  path: string;
  language: LanguageId;
  region: "file" | VueRegion;
  startLine: number;
  endLine: number;
  bestEffort: boolean;
}

const BLOCK_TAGS = ["script", "template", "style"] as const;

/** True for every language the product does not promise full support for. */
export function isBestEffort(language: LanguageId): boolean {
  return !(PREFERRED_LANGUAGES as readonly string[]).includes(language);
}

function lineAt(source: string, index: number): number {
  let line = 1;
  const limit = Math.min(Math.max(index, 0), source.length);
  for (let i = 0; i < limit; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/** Content line range, trimmed of surrounding blank/whitespace-only lines. */
function contentRange(
  source: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  let first = start;
  while (first < end && /\s/u.test(source[first])) {
    first += 1;
  }
  if (first >= end) {
    const line = lineAt(source, start);
    return { startLine: line, endLine: line };
  }
  let last = end - 1;
  while (last > first && /\s/u.test(source[last])) {
    last -= 1;
  }
  return { startLine: lineAt(source, first), endLine: lineAt(source, last) };
}

/**
 * Finds the closing tag matching an already-consumed opening tag. Nested
 * same-name tags are counted, which keeps `<template v-if>` inside a
 * `<template>` block in one piece.
 */
function findClosingTag(
  source: string,
  tag: string,
  from: number,
): { start: number; end: number } | null {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "giu");
  const close = new RegExp(`</${tag}\\s*>`, "giu");
  let depth = 1;
  let cursor = from;
  while (cursor < source.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(source);
    const nextClose = close.exec(source);
    if (nextClose === null) {
      return null;
    }
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      if (depth === 0) {
        return { start: nextClose.index, end: close.lastIndex };
      }
      cursor = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

/**
 * Splits a Vue SFC into its top-level blocks in source order. Attributes are
 * returned verbatim (`setup` ⇒ `""`); `startLine`/`endLine` are the first and
 * last line of the block body, not of the tags.
 */
export function splitVueSfc(source: string): VueBlock[] {
  const blocks: VueBlock[] = [];
  const open = new RegExp(
    `<(${BLOCK_TAGS.join("|")})((?:\\s[^>]*?)?)(/?)>`,
    "giu",
  );
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    const kind = match[1].toLowerCase() as VueRegion;
    const attrs = parseAttrs(match[2] ?? "");
    const openEnd = open.lastIndex;

    if (match[3] === "/") {
      const line = lineAt(source, match.index);
      blocks.push({ kind, startLine: line, endLine: line, attrs });
      continue;
    }

    const close = findClosingTag(source, kind, openEnd);
    if (close === null) {
      const range = contentRange(source, openEnd, source.length);
      blocks.push({ kind, ...range, attrs });
      break;
    }
    const range = contentRange(source, openEnd, close.start);
    blocks.push({ kind, ...range, attrs });
    // Continue scanning after this block so nested `<template>` tags are not
    // reported twice.
    open.lastIndex = close.end;
  }
  return blocks;
}

function fileLineCount(source: string): number {
  const trimmed = source.replace(/(?:\r?\n)+$/u, "");
  return trimmed === "" ? 1 : trimmed.split(/\r?\n/u).length;
}

/**
 * Evidence regions for one file: Vue yields one slice per SFC block, every
 * other file yields the whole file. `bestEffort` mirrors `isBestEffort`.
 */
export function evidenceSlicesFor(
  path: string,
  source: string,
): EvidenceSlice[] {
  const language = languageOf(path);
  const bestEffort = isBestEffort(language);
  if (language === "vue") {
    const blocks = splitVueSfc(source);
    if (blocks.length > 0) {
      return blocks.map((block) => ({
        path,
        language,
        region: block.kind,
        startLine: block.startLine,
        endLine: block.endLine,
        bestEffort,
      }));
    }
  }
  return [
    {
      path,
      language,
      region: "file",
      startLine: 1,
      endLine: fileLineCount(source),
      bestEffort,
    },
  ];
}
