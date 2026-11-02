/**
 * The frozen route table and the route-module registry (architecture §14.1,
 * §3.8, §3.13).
 *
 * `ROUTES` is the executable source of truth for the 32 HTTP endpoints: the 31
 * `/api/*` routes of PRD §5 plus `GET /session/bootstrap`. The route↔DTO table
 * in §3.8 is the reviewable projection; `test/learning/api/route-allowlist`
 * asserts the two ordered lists are equal, so neither may drift by one entry.
 *
 * `AuthMode`, `RouteDef`, `RouteHandlerKey` and `RouteModule` are DECLARED in
 * `contracts/ports.ts`; this module only re-exports them. RedECLARING them here
 * would break the contracts-leaf rule (§2.2) and split the type identity.
 *
 * Route modules arrive through {@link registerRouteModule}; the server binds
 * their handler factories to `AppDeps` at creation time. The UI is a separate
 * typed seam (`ServerOptions.ui`) so `api/server.ts` never imports `ui/`.
 */

import { LearningError, errorMessageFor } from "../contracts/index.js";
import type {
  AuthMode,
  HandlerFactory,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
} from "../contracts/index.js";

export type { AuthMode, RouteDef, RouteHandlerKey, RouteModule };

/** All HTTP methods the route table may declare, in `Allow`-header order. */
const METHOD_ORDER: readonly RouteDef["method"][] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
];

function route(
  method: RouteDef["method"],
  pattern: string,
  auth: AuthMode,
  handler: RouteHandlerKey,
): RouteDef {
  return Object.freeze({ method, pattern, auth, handler });
}

/**
 * The exact 32-entry route table (PRD §5 + `/session/bootstrap`).
 *
 * Deliberate deviations (architecture §14.1): manual refresh is an optional
 * body field on `PUT /api/projects/:id/watch`, and the upstream visualizer is
 * not mounted, so `GET /` belongs to the UI seam rather than this table.
 */
export const ROUTES: readonly RouteDef[] = Object.freeze([
  route("GET", "/api/health", "public", "health"),
  route("GET", "/session/bootstrap", "public", "bootstrap"),
  route("POST", "/api/projects", "session", "projects.create"),
  route("GET", "/api/projects", "session", "projects.list"),
  route("GET", "/api/projects/:id", "session", "projects.get"),
  route("GET", "/api/projects/:id/dependents", "session", "projects.dependents"),
  route("DELETE", "/api/projects/:id", "session", "projects.delete"),
  route("POST", "/api/projects/:id/analyses", "session", "analyses.create"),
  route("POST", "/api/projects/:id/comparisons", "session", "comparisons.create"),
  route("GET", "/api/jobs/:id", "session", "jobs.get"),
  route("GET", "/api/jobs/:id/events", "session", "jobs.events"),
  route("POST", "/api/jobs/:id/cancel", "session", "jobs.cancel"),
  route("POST", "/api/jobs/:id/retry", "session", "jobs.retry"),
  route("GET", "/api/generations/:id/lessons", "session", "generations.lessons"),
  route(
    "GET",
    "/api/generations/:id/lessons/:lessonId",
    "session",
    "generations.lesson",
  ),
  route(
    "GET",
    "/api/generations/:id/sources/:sourceId",
    "session",
    "generations.source",
  ),
  route(
    "GET",
    "/api/generations/:id/coverage",
    "session",
    "generations.coverage",
  ),
  route("POST", "/api/conversations", "session", "conversations.create"),
  route("GET", "/api/conversations/:id", "session", "conversations.get"),
  route(
    "GET",
    "/api/conversations/:id/messages",
    "session",
    "conversations.messages",
  ),
  route(
    "POST",
    "/api/conversations/:id/messages",
    "session",
    "conversations.post",
  ),
  route("PUT", "/api/projects/:id/watch", "session", "watch.put"),
  route("GET", "/api/projects/:id/changes", "session", "changes.list"),
  route(
    "GET",
    "/api/projects/:id/changes/:changeId",
    "session",
    "changes.get",
  ),
  route("GET", "/api/preferences", "session", "preferences.get"),
  route("PUT", "/api/preferences", "session", "preferences.put"),
  route("GET", "/api/terms", "session", "terms.list"),
  route("GET", "/api/terms/:id", "session", "terms.get"),
  route("GET", "/api/settings/model", "session", "settings.model.get"),
  route("PUT", "/api/settings/model", "session", "settings.model.put"),
  route("GET", "/api/usage", "session", "usage.get"),
  route("GET", "/api/storage", "session", "storage.get"),
]);

/** Every handler key the table names; used to reject module typos early. */
export const ROUTE_HANDLER_KEYS: ReadonlySet<RouteHandlerKey> = new Set(
  ROUTES.map((r) => r.handler),
);

// ── pattern matching ────────────────────────────────────────────────────────

/** Splits a path into non-empty segments, ignoring a leading/trailing slash. */
export function pathSegments(value: string): string[] {
  const trimmed = value.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

function invalidInput(message: string, details?: Record<string, unknown>) {
  return new LearningError(
    "invalid_input",
    message,
    details === undefined ? undefined : details,
  );
}

function outOfScope(path: string, param: string, value: string): LearningError {
  return new LearningError(
    "out_of_scope_path",
    errorMessageFor("out_of_scope_path", "zh"),
    { param, value, path },
  );
}

/**
 * Decodes one path segment. Malformed percent-encoding is `invalid_input`;
 * a decoded segment that could change the meaning of a path (`..`, `/`, `\`,
 * NUL, leading slash) is `out_of_scope_path` and is rejected before any
 * handler can touch the filesystem (AC-API-05).
 */
function decodeParam(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw invalidInput(errorMessageFor("invalid_input", "zh"), {
      field: "path",
    });
  }
  if (
    decoded === "" ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.startsWith("/")
  ) {
    throw outOfScope(segment, "path", decoded);
  }
  return decoded;
}

/**
 * Matches one pattern against a path. `:name` captures a single non-empty
 * segment; a terminal `*` captures the remaining path (used only by the UI
 * seam for `/assets/*`). Returns `null` when the pattern does not match.
 */
export function matchPattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternSegments = pathSegments(pattern);
  const pathParts = pathSegments(pathname);
  const params: Record<string, string> = {};

  let index = 0;
  for (; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    if (expected === "*") {
      params["*"] = pathParts.slice(index).join("/");
      return params;
    }
    const actual = pathParts[index];
    if (actual === undefined || actual === "") return null;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeParam(actual);
      continue;
    }
    if (expected !== actual) return null;
  }

  return index === pathParts.length ? params : null;
}

// ── route matching ──────────────────────────────────────────────────────────

export type RouteMatch =
  | { route: RouteDef; params: Record<string, string> }
  | { allow: string[] }
  | null;

/** Canonical `Allow` ordering, filtered to the methods the path accepts. */
function allowHeader(methods: ReadonlySet<string>): string[] {
  return METHOD_ORDER.filter((m) => methods.has(m));
}

/**
 * Resolves a request to a route. When the path matches but the method does
 * not, returns the sorted `Allow` list so the server can emit a 405 with a
 * correct header (AC-API-08). An unknown path returns `null`.
 */
export function matchRoute(method: string, pathname: string): RouteMatch {
  const wanted = method.toUpperCase();
  const allowed = new Set<string>();

  for (const candidate of ROUTES) {
    const params = matchPattern(candidate.pattern, pathname);
    if (params === null) continue;
    if (candidate.method === wanted) {
      return { route: candidate, params };
    }
    allowed.add(candidate.method);
  }

  if (allowed.size > 0) return { allow: allowHeader(allowed) };
  return null;
}

// ── module registry ─────────────────────────────────────────────────────────

interface RegisteredModule {
  readonly id: RouteModule["id"];
  readonly handlers: ReadonlyMap<RouteHandlerKey, HandlerFactory>;
}

const MODULES = new Map<string, RegisteredModule>();

/**
 * Registers a route module. The module may only declare routes that exist in
 * {@link ROUTES} with the same handler key, and may only supply handlers the
 * table names. A second module may not claim a key another module owns;
 * re-registering the same module id replaces it (tests reuse one stub id).
 */
export function registerRouteModule(module: RouteModule): void {
  const seenRoutes = new Set<string>();
  for (const declared of module.routes) {
    const key = `${declared.method} ${declared.pattern}`;
    if (seenRoutes.has(key)) {
      throw new LearningError("conflict", `路由重复注册: ${key}`, {
        route: key,
      });
    }
    seenRoutes.add(key);

    const known = ROUTES.find(
      (r) => r.method === declared.method && r.pattern === declared.pattern,
    );
    if (known === undefined) {
      throw invalidInput(`未知路由: ${key}`, { route: key });
    }
    if (known.handler !== declared.handler) {
      throw invalidInput(`路由处理器不匹配: ${key}`, { route: key });
    }
  }

  const handlers = new Map<RouteHandlerKey, HandlerFactory>();
  for (const [rawKey, factory] of Object.entries(module.handlers) as [
    string,
    HandlerFactory | undefined,
  ][]) {
    if (factory === undefined) continue;
    const key = rawKey as RouteHandlerKey;
    if (!ROUTE_HANDLER_KEYS.has(key)) {
      throw invalidInput(`未知处理器: ${rawKey}`, { handler: rawKey });
    }
    handlers.set(key, factory);
  }

  for (const [otherId, other] of MODULES) {
    if (otherId === module.id) continue;
    for (const key of handlers.keys()) {
      if (other.handlers.has(key)) {
        throw new LearningError("conflict", `处理器重复注册: ${key}`, {
          handler: key,
        });
      }
    }
  }

  MODULES.set(module.id, { id: module.id, handlers });
}

/** A snapshot of every handler factory registered so far. */
export function registeredHandlers(): ReadonlyMap<RouteHandlerKey, HandlerFactory> {
  const merged = new Map<RouteHandlerKey, HandlerFactory>();
  for (const module of MODULES.values()) {
    for (const [key, factory] of module.handlers) {
      merged.set(key, factory);
    }
  }
  return merged;
}
