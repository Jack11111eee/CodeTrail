/**
 * Request validation (architecture §3.8, §14.2).
 *
 * `REQ_SCHEMAS` is the single table of body/query schemas, keyed by
 * `RouteHandlerKey`. The server validates *before* calling a handler and
 * rejects unknown fields, so a handler only ever sees a clean object. Every
 * failure becomes `invalid_input` (400) with the Zod issue paths in
 * `details.issues`; no absolute path or stack ever enters the body.
 */

import { z } from "zod";

import { LearningError, errorMessageFor } from "../contracts/index.js";
import type { RouteHandlerKey } from "../contracts/index.js";

export interface RouteSchema {
  readonly body?: z.ZodType<unknown>;
  readonly query?: z.ZodType<unknown>;
}

function invalidInput(details?: Record<string, unknown>): LearningError {
  return new LearningError(
    "invalid_input",
    errorMessageFor("invalid_input", "zh"),
    details,
  );
}

function fromZod(error: z.ZodError): LearningError {
  const issues = error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  return invalidInput({ issues });
}

// ── building blocks ─────────────────────────────────────────────────────────

const id = z.string().min(1).max(512);
const nonEmptyString = z.string().min(1);

const scope = z
  .object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    maxFiles: z.number().int().positive().optional(),
    maxFileBytes: z.number().int().positive().optional(),
  })
  .strict();

const generationConfig = z
  .object({
    language: z.literal("zh").optional(),
    model: z
      .object({
        provider: nonEmptyString,
        model: nonEmptyString,
        maxOutputTokens: z.number().int().positive(),
        temperature: z.number().min(0),
      })
      .strict()
      .optional(),
    pageConcurrency: z.number().int().positive().optional(),
    promptTemplateVersion: nonEmptyString.optional(),
    lessonPipelineVersion: nonEmptyString.optional(),
    includeTests: z.boolean().optional(),
    externalDocs: z
      .object({
        enabled: z.boolean(),
        maxPerLesson: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const codeLocation = z
  .object({
    path: nonEmptyString,
    lines: z
      .object({
        start: z.number().int().positive(),
        end: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const selection = z
  .object({
    lessonId: id.optional(),
    moduleId: nonEmptyString.optional(),
    sourceId: id.optional(),
    // A diagram node can bind several evidence ids; the click submits them all
    // together with the generation's commit (AC-UI-04).
    sourceIds: z.array(id).max(64).optional(),
    commitSha: nonEmptyString.max(128).optional(),
    codeLocation: codeLocation.optional(),
  })
  .strict();

const localPathProject = z.object({ localPath: nonEmptyString }).strict();
const githubProject = z
  .object({
    githubUrl: nonEmptyString.refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    }, "must be an http(s) URL"),
    ref: nonEmptyString.optional(),
  })
  .strict();

const createProjectBody = z.union([localPathProject, githubProject]);

/**
 * AC-PRJ-02 / §5.1: naming both sources has its own documented reason. The
 * strict union would reject such a body with a generic issue list, so the
 * mutual-exclusion guard runs first; every other shape still goes through the
 * union (and the handler) to keep `not_git_repo`, `invalid_path` and
 * `out_of_scope_path` distinct.
 */
function precheckProjectSource(body: unknown): void {
  if (body === null || typeof body !== "object") return;
  if ("localPath" in body && "githubUrl" in body) {
    throw invalidInput({ reason: "local_path_and_url" });
  }
}

const createAnalysisBody = z
  .object({
    ref: nonEmptyString,
    scope: scope.optional(),
    config: generationConfig.optional(),
  })
  .strict();

const createComparisonBody = z
  .object({
    baseSha: nonEmptyString,
    headSha: nonEmptyString,
    scope: scope.optional(),
    config: generationConfig.optional(),
  })
  .strict();

const createConversationBody = z
  .object({
    generationIds: z.array(id).min(1).max(2),
    lessonId: id.optional(),
    moduleId: nonEmptyString.optional(),
  })
  .strict();

const postMessageBody = z
  .object({
    text: nonEmptyString,
    selection: selection.optional(),
  })
  .strict();

const putWatchBody = z
  .object({
    enabled: z.boolean(),
    scope: scope.optional(),
    refreshNow: z.boolean().optional(),
  })
  .strict();

const putPreferencesBody = z
  .object({
    explainLevel: z.enum(["plain_first", "technical_first"]).optional(),
    background: z.string().nullable().optional(),
    readingPosition: z
      .object({
        generationId: id,
        lessonId: id,
        offset: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const putModelSettingsBody = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).optional(),
    pricing: z
      .object({
        inputCentsPerMTok: z.number().nonnegative(),
        outputCentsPerMTok: z.number().nonnegative(),
      })
      .strict()
      .nullable()
      .optional(),
    quota: z
      .object({
        maxCalls: z.number().int().nonnegative().optional(),
        maxInputTokens: z.number().int().nonnegative().optional(),
        maxOutputTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const limitString = z
  .string()
  .regex(/^\d+$/u, "must be a non-negative integer");

// `confirm` is interpreted by the handler, not by the schema: a missing or
// non-`true` value must be `invalid_input` with `details.reason="confirm_required"`
// (§5.8), not a generic Zod issue list.
const deleteProjectQuery = z
  .object({ confirm: z.string().optional() })
  .strict();
const messageListQuery = z
  .object({ limit: limitString.optional(), before: nonEmptyString.optional() })
  .strict();
const changesListQuery = z
  .object({ cursor: nonEmptyString.optional(), limit: limitString.optional() })
  .strict();
const termsListQuery = z.object({ q: z.string().optional() }).strict();
const usageQuery = z
  .object({
    kind: z
      .enum(["initial", "update", "comparison", "qa", "change"])
      .optional(),
  })
  .strict();

/** The body/query schema table, keyed by route handler. */
export const REQ_SCHEMAS: Readonly<
  Partial<Record<RouteHandlerKey, RouteSchema>>
> = Object.freeze({
  "projects.create": { body: createProjectBody },
  "projects.delete": { query: deleteProjectQuery },
  "analyses.create": { body: createAnalysisBody },
  "comparisons.create": { body: createComparisonBody },
  "conversations.create": { body: createConversationBody },
  "conversations.messages": { query: messageListQuery },
  "conversations.post": { body: postMessageBody },
  "watch.put": { body: putWatchBody },
  "changes.list": { query: changesListQuery },
  "preferences.put": { body: putPreferencesBody },
  "terms.list": { query: termsListQuery },
  "settings.model.put": { body: putModelSettingsBody },
  "usage.get": { query: usageQuery },
});

/**
 * Parses a body buffer. Empty input is `undefined`; malformed JSON is
 * `invalid_input` (AC-API-11). Validation of the parsed value happens later,
 * after the route (and therefore its schema) is known.
 */
export function parseJsonBody(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidInput({ field: "body", problem: "malformed_json" });
  }
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

/** Validates (and strips) a parsed body for `handler`; unknown keys fail. */
export function validateBody(handler: RouteHandlerKey, body: unknown): unknown {
  // Cross-field rules that own a documented `details.reason` must see the raw
  // body before the schema turns the rejection into a generic issue list.
  if (handler === "projects.create") precheckProjectSource(body);
  const schema = REQ_SCHEMAS[handler]?.body;
  if (schema === undefined) return body;
  return parseWith(schema, body);
}

/**
 * Validates the query object for `handler`. Query values stay strings, as
 * `RouteRequest.query` declares.
 */
export function validateQuery(
  handler: RouteHandlerKey,
  query: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const schema = REQ_SCHEMAS[handler]?.query;
  if (schema === undefined) return query;
  return parseWith(schema, query) as Readonly<Record<string, string>>;
}
