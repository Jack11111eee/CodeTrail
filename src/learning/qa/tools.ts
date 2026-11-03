/**
 * The closed read-only tool registry (architecture §11.1, PRD §9, AC-QA-07).
 *
 * Exactly five tools exist. There is deliberately no write, edit, delete,
 * execute, SQL or shell tool and no generic URL fetcher: `read_snapshot_file`
 * goes through `assertReadable`, and `read_external_doc` only serves a canonical
 * URL that the evidence registry already recorded. `assertNoWriteTools` is the
 * runtime assertion that keeps the set closed even if a later edit adds a def.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { LearningError, sourceIdOf } from "../contracts/index.js";
import type {
  Binding,
  ExternalDocService,
  NormalizedScope,
  PublishedGenerationRef,
  SnapshotReader,
  SourceId,
  SourceRegistry,
  ToolBudget,
} from "../contracts/index.js";
import { repoSourceId } from "../evidence/registry.js";
import { assertReadable } from "../projects/scope.js";

export type QaToolName =
  | "search_wiki"
  | "read_page"
  | "read_snapshot_file"
  | "resolve_evidence"
  | "read_external_doc";

/** The complete whitelist, in the architecture's order. */
export const QA_TOOL_NAMES: readonly QaToolName[] = Object.freeze([
  "search_wiki",
  "read_page",
  "read_snapshot_file",
  "resolve_evidence",
  "read_external_doc",
] as const);

export interface QaToolContext {
  binding: Binding;
  generation: PublishedGenerationRef;
  snapshot: SnapshotReader;
  scope: NormalizedScope;
  registry: SourceRegistry;
  external: ExternalDocService;
  budget: ToolBudget;
}

export interface QaToolResult {
  content: string;
  citations: SourceId[];
}

export interface QaToolDef {
  name: QaToolName;
  description: string;
  schema: z.ZodTypeAny;
  readOnly: true;
  run(args: unknown, ctx: QaToolContext): Promise<QaToolResult>;
}

const FORBIDDEN_TOOL_NAME =
  /write|edit|delete|remove|execute|exec|sql|shell|bash|spawn|run_command|fetch_url|http_request/iu;
const FORBIDDEN_METHODS = new Set([
  "write",
  "edit",
  "delete",
  "remove",
  "execute",
  "exec",
  "sql",
  "shell",
  "bash",
  "spawn",
  "fetch",
]);

function invalid(message: string, details?: Record<string, unknown>): LearningError {
  return new LearningError("invalid_input", message, details);
}

function wikiSourceId(generationId: string, page: string): SourceId {
  return sourceIdOf("repo", `wiki\0${generationId}\0${page}\0`);
}

function wikiRoot(ctx: QaToolContext): string {
  return path.join(ctx.generation.knowledgeDir, "openwiki");
}

function safePagePath(root: string, page: string): string {
  if (page.includes("\0") || path.isAbsolute(page)) {
    throw invalid("页面路径无效", { page });
  }
  const candidate = path.resolve(root, `${page}.md`);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw invalid("页面路径越界", { page });
  }
  return candidate;
}

function readWikiPage(ctx: QaToolContext, page: string): string {
  const root = wikiRoot(ctx);
  const file = safePagePath(root, page);
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new LearningError("not_found", "页面不存在", { page });
  }
}

function searchWikiFiles(
  ctx: QaToolContext,
  query: string,
  limit: number,
): { page: string; text: string; score: number }[] {
  const root = wikiRoot(ctx);
  let files: string[];
  try {
    files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.replace(/\\/gu, "/"))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term !== "");
  const hits: { page: string; text: string; score: number }[] = [];
  for (const entry of files) {
    let text: string;
    try {
      text = readFileSync(path.join(root, entry), "utf8");
    } catch {
      continue;
    }
    const haystack = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const occurrences = haystack.split(term).length - 1;
      score += occurrences;
    }
    if (score > 0) {
      hits.push({ page: entry.replace(/\.md$/u, ""), text, score });
    }
  }
  hits.sort(
    (left, right) =>
      right.score - left.score || left.page.localeCompare(right.page),
  );
  return hits.slice(0, limit);
}

function snippet(text: string, max = 400): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function externalRefFor(
  ctx: QaToolContext,
  url: string,
): { sourceId: SourceId; contentHash: string } | null {
  for (const ref of ctx.registry.all(ctx.generation.generationId)) {
    if (ref.kind !== "external") continue;
    if (ref.canonicalUrl !== url) continue;
    return { sourceId: ref.sourceId, contentHash: ref.contentHash };
  }
  return null;
}

const SEARCH_WIKI_SCHEMA = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(10).optional(),
});
const READ_PAGE_SCHEMA = z.object({ page: z.string().min(1) });
const READ_SNAPSHOT_SCHEMA = z.object({
  path: z.string().min(1),
  lines: z
    .object({
      start: z.number().int().positive(),
      end: z.number().int().positive(),
    })
    .optional(),
});
const RESOLVE_EVIDENCE_SCHEMA = z.object({ sourceId: z.string().min(1) });
const READ_EXTERNAL_SCHEMA = z.object({
  url: z.string().min(1),
  locator: z.string().optional(),
});

function toolDefs(): QaToolDef[] {
  return [
    {
      name: "search_wiki",
      description:
        "Search the published knowledge pages of the bound generation and return ranked excerpts.",
      schema: SEARCH_WIKI_SCHEMA,
      readOnly: true,
      run(args, ctx) {
        const parsed = SEARCH_WIKI_SCHEMA.safeParse(args);
        if (!parsed.success) {
          throw invalid("search_wiki 参数无效", {
            issue: parsed.error.message,
          });
        }
        const input = parsed.data;
        const hits = searchWikiFiles(ctx, input.query, input.limit ?? 5);
        const citations: SourceId[] = [];
        const parts: string[] = [];
        for (const hit of hits) {
          const sourceId = wikiSourceId(ctx.generation.generationId, hit.page);
          citations.push(sourceId);
          parts.push(`[来源: ${sourceId}] ${hit.page}\n${snippet(hit.text)}`);
        }
        return Promise.resolve({ content: parts.join("\n\n"), citations });
      },
    },
    {
      name: "read_page",
      description: "Read one published knowledge page of the bound generation.",
      schema: READ_PAGE_SCHEMA,
      readOnly: true,
      run(args, ctx) {
        const parsed = READ_PAGE_SCHEMA.safeParse(args);
        if (!parsed.success) {
          throw invalid("read_page 参数无效", { issue: parsed.error.message });
        }
        const { page } = parsed.data;
        const text = readWikiPage(ctx, page);
        return Promise.resolve({
          content: text,
          citations: [wikiSourceId(ctx.generation.generationId, page)],
        });
      },
    },
    {
      name: "read_snapshot_file",
      description:
        "Read a file (or a 1-based inclusive line range) from the immutable snapshot of the bound generation.",
      schema: READ_SNAPSHOT_SCHEMA,
      readOnly: true,
      async run(args, ctx) {
        const parsed = READ_SNAPSHOT_SCHEMA.safeParse(args);
        if (!parsed.success) {
          throw invalid("read_snapshot_file 参数无效", {
            issue: parsed.error.message,
          });
        }
        const input = parsed.data;
        if (
          ctx.snapshot.repoId !== ctx.binding.repoId ||
          ctx.snapshot.commitSha !== ctx.binding.commitSha
        ) {
          throw new LearningError("version_mismatch", "快照与绑定版本不一致", {
            generationId: ctx.binding.generationId,
            expectedCommitSha: ctx.binding.commitSha,
            snapshotCommitSha: ctx.snapshot.commitSha,
          });
        }
        assertReadable(input.path, ctx.scope);
        const content =
          input.lines === undefined
            ? await ctx.snapshot.read(input.path)
            : await ctx.snapshot.slice(input.path, input.lines);
        return {
          content,
          citations: [
            repoSourceId(
              input.path,
              ctx.binding.commitSha,
              input.lines === undefined ? null : input.lines,
            ),
          ],
        };
      },
    },
    {
      name: "resolve_evidence",
      description:
        "Look up an already registered evidence source of the bound generation.",
      schema: RESOLVE_EVIDENCE_SCHEMA,
      readOnly: true,
      run(args, ctx) {
        const parsed = RESOLVE_EVIDENCE_SCHEMA.safeParse(args);
        if (!parsed.success) {
          throw invalid("resolve_evidence 参数无效", {
            issue: parsed.error.message,
          });
        }
        const { sourceId } = parsed.data;
        const ref = ctx.registry.get(
          ctx.generation.generationId,
          sourceId as SourceId,
        );
        if (ref === null) {
          throw new LearningError("not_found", "来源未登记", { sourceId });
        }
        return Promise.resolve({
          content: JSON.stringify(ref),
          citations: [ref.sourceId],
        });
      },
    },
    {
      name: "read_external_doc",
      description:
        "Read an external document that is already registered for the bound generation. Arbitrary URLs are rejected.",
      schema: READ_EXTERNAL_SCHEMA,
      readOnly: true,
      async run(args, ctx) {
        const parsed = READ_EXTERNAL_SCHEMA.safeParse(args);
        if (!parsed.success) {
          throw invalid("read_external_doc 参数无效", {
            issue: parsed.error.message,
          });
        }
        const { url } = parsed.data;
        const ref = externalRefFor(ctx, url);
        if (ref === null) {
          throw invalid("外部资料未登记，拒绝读取任意 URL", { url });
        }
        const text = await ctx.external.cached(ref.contentHash);
        if (text === null) {
          throw new LearningError(
            "external_source_unavailable",
            "外部资料暂不可用",
            { sourceId: ref.sourceId, url },
          );
        }
        return { content: text, citations: [ref.sourceId] };
      },
    },
  ];
}

/**
 * The runtime assertion that the registry stays closed. Throws `internal_error`
 * for an unknown name, a mutating name, a non-read-only def, or a def that
 * exposes a mutating method.
 */
export function assertNoWriteTools(tools: { name: string }[]): void {
  const allowed = new Set<string>(QA_TOOL_NAMES);
  for (const tool of tools) {
    const name = tool.name;
    if (typeof name !== "string" || name === "") {
      throw new LearningError("internal_error", "工具缺少名称", { tool });
    }
    if (FORBIDDEN_TOOL_NAME.test(name) || !allowed.has(name)) {
      throw new LearningError("internal_error", "工具不在只读白名单内", { name });
    }
    const candidate = tool as unknown as Record<string, unknown>;
    if ("readOnly" in candidate && candidate.readOnly !== true) {
      throw new LearningError("internal_error", "工具必须声明 readOnly", { name });
    }
    for (const key of Object.keys(candidate)) {
      if (FORBIDDEN_METHODS.has(key) && typeof candidate[key] === "function") {
        throw new LearningError("internal_error", "工具暴露了写/执行方法", {
          name,
          method: key,
        });
      }
    }
  }
}

/** Builds the five-tool set bound to one generation. */
export function createQaToolset(ctx: QaToolContext): QaToolDef[] {
  if (ctx.binding.generationId !== ctx.generation.generationId) {
    throw new LearningError("version_mismatch", "工具上下文绑定了不同版本", {
      bindingGenerationId: ctx.binding.generationId,
      generationId: ctx.generation.generationId,
    });
  }
  const tools = toolDefs();
  assertNoWriteTools(tools);
  return tools;
}

/** A budgeted tool counter; `canCall` is checked before every execution. */
export function createToolBudget(limits: {
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}): ToolBudget {
  const used = { calls: 0, inputTokens: 0, outputTokens: 0 };
  return {
    maxToolCalls: limits.maxToolCalls,
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    used,
    canCall(): boolean {
      return (
        used.calls < limits.maxToolCalls &&
        used.inputTokens < limits.maxInputTokens &&
        used.outputTokens < limits.maxOutputTokens
      );
    },
    consume(c: { inputTokens: number; outputTokens: number }): void {
      used.calls += 1;
      used.inputTokens += Math.max(0, Math.trunc(c.inputTokens));
      used.outputTokens += Math.max(0, Math.trunc(c.outputTokens));
    },
    exhausted(): boolean {
      return (
        used.calls >= limits.maxToolCalls ||
        used.inputTokens >= limits.maxInputTokens ||
        used.outputTokens >= limits.maxOutputTokens
      );
    },
  };
}
