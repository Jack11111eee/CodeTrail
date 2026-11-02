/**
 * The single HTTP entry surface (architecture §14.2).
 *
 * One loopback `node:http` listener runs the ordered chain:
 *
 *   rejectNonLoopbackSocket → parseUrl → assertHost → assertOrigin
 *   (state-changing) → assertSession (non-public) → readBody (≤1 MiB)
 *   → matchRoute → 405/Allow → handler → send
 *
 * Every error funnels through `toErrorBody` (AC-API-07); the status always
 * comes from `HTTP_STATUS_BY_CODE`. The UI is injected through the typed
 * `StaticUiSeam`, and route modules through `registerRouteModule`, so this
 * file never imports a sibling that has not been built yet.
 *
 * `ServerOptions`, `RunningServer`, `RouteRequest`/`RouteResponse` and the
 * route plumbing types live in `contracts/ports.ts`; they are re-exported
 * here and never redeclared (§3.13).
 */

import http from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import {
  assertHost,
  assertLoopbackListenHost,
  assertLoopbackPeer,
  assertOrigin,
  assertSession,
  isStateChangingMethod,
  LOOPBACK_HOST,
  mintSessionCookie,
} from "./auth.js";
import { sendEmpty, sendHtml, sendJson, sendSse } from "./respond.js";
import { matchPattern, matchRoute, ROUTES, registeredHandlers } from "./router.js";
import { parseJsonBody, validateBody, validateQuery } from "./validate.js";
import { CODETRAIL_VERSION, MAX_BODY_BYTES, UPSTREAM_COMMIT } from "../config/defaults.js";
import { LearningError, errorMessageFor, toErrorBody } from "../contracts/index.js";
import type {
  AppDeps,
  RouteHandlerKey,
  RouteRequest,
  RouteResponse,
  RunningServer,
  ServerOptions,
  StaticUiSeam,
} from "../contracts/index.js";

export type {
  AppDeps,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
  RunningServer,
  ServerOptions,
  StaticUiSeam,
} from "../contracts/index.js";

/** A handler bound to `AppDeps`. */
type BoundHandler = (req: RouteRequest) => Promise<RouteResponse>;

interface ServerState {
  port: number;
  readonly deps: AppDeps;
  readonly ui: StaticUiSeam | undefined;
  readonly handlers: ReadonlyMap<RouteHandlerKey, BoundHandler>;
}

// ── request plumbing ────────────────────────────────────────────────────────

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

function requestHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function invalidInput(details?: Record<string, unknown>): LearningError {
  return new LearningError(
    "invalid_input",
    errorMessageFor("invalid_input", "zh"),
    details,
  );
}

function notFound(): LearningError {
  return new LearningError("not_found", errorMessageFor("not_found", "zh"));
}

function methodNotAllowed(): LearningError {
  return new LearningError(
    "method_not_allowed",
    errorMessageFor("method_not_allowed", "zh"),
  );
}

/**
 * Rejects a path segment that could escape a sandbox before any route (and
 * therefore any filesystem call) runs. Literal `..` is caught here even
 * though `new URL` would normalise it away (AC-API-05).
 */
function assertSafeRawPath(rawPath: string): void {
  for (const segment of rawPath.split("/")) {
    if (segment === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalidInput({ field: "path" });
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.startsWith("/")
    ) {
      throw new LearningError(
        "out_of_scope_path",
        errorMessageFor("out_of_scope_path", "zh"),
        { path: rawPath, value: decoded },
      );
    }
  }
}

interface ParsedUrl {
  pathname: string;
  query: Record<string, string>;
}

function parseRequestUrl(rawUrl: string): ParsedUrl {
  // Absolute-form request targets (proxy style) and protocol-relative paths
  // are never valid on this listener.
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
    throw invalidInput({ field: "path" });
  }
  const questionMark = rawUrl.indexOf("?");
  const rawPath = questionMark === -1 ? rawUrl : rawUrl.slice(0, questionMark);
  assertSafeRawPath(rawPath);

  let url: URL;
  try {
    url = new URL(rawUrl, `http://${LOOPBACK_HOST}`);
  } catch {
    throw invalidInput({ field: "path" });
  }

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!(key in query)) query[key] = value;
  }
  return { pathname: url.pathname, query };
}

/**
 * Reads and parses a JSON body with the 1 MiB cap. An oversized body is fully
 * drained (so the client can finish writing) and then rejected with 413; a
 * malformed body is 400 (AC-API-11). GET/HEAD bodies are ignored.
 */
async function readBody(
  req: IncomingMessage,
  method: string,
  maxBytes: number,
): Promise<unknown> {
  if (method === "GET" || method === "HEAD") {
    req.resume();
    return undefined;
  }

  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }

  if (tooLarge) {
    throw new LearningError(
      "payload_too_large",
      errorMessageFor("payload_too_large", "zh"),
      { limitBytes: maxBytes },
    );
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return parseJsonBody(text);
}

// ── response writing ────────────────────────────────────────────────────────

function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (base === undefined && extra === undefined) return undefined;
  return { ...(base ?? {}), ...(extra ?? {}) };
}

function contentTypeOf(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (headers === undefined) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return value;
  }
  return undefined;
}

function looksLikeHtml(body: unknown): body is string {
  return (
    typeof body === "string" && /^\s*<(?:!doctype\s+html|html)\b/iu.test(body)
  );
}

async function sendRouteResponse(
  res: ServerResponse,
  response: RouteResponse,
  extraHeaders: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (response.kind === "sse") {
    await sendSse(res, response.events, signal);
    return;
  }

  const headers = mergeHeaders(response.headers, extraHeaders);
  if (response.kind === "empty") {
    sendEmpty(res, response.status, headers);
    return;
  }

  const contentType = contentTypeOf(headers);
  const isHtmlBody =
    looksLikeHtml(response.body) ||
    (contentType ?? "").toLowerCase().startsWith("text/html");
  if (isHtmlBody) {
    const html =
      typeof response.body === "string" ? response.body : String(response.body);
    sendHtml(res, response.status, html, headers);
    return;
  }

  sendJson(res, response.status, response.body, headers);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * An HTML error page never carries the stack or an absolute data path; the
 * strict CSP comes from `sendHtml` (AC-SEC-05).
 */
function sendHtmlError(
  res: ServerResponse,
  status: number,
  body: ReturnType<typeof toErrorBody>,
): void {
  const title = `${String(status)} ${escapeHtml(body.error.code)}`;
  const html =
    "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">" +
    `<title>${title}</title></head><body>` +
    `<h1>${escapeHtml(body.error.code)}</h1>` +
    `<p>${escapeHtml(body.error.message)}</p>` +
    "</body></html>";
  sendHtml(res, status, html);
}

function respondError(
  res: ServerResponse,
  error: unknown,
  wantsHtml: boolean,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    // A stream already committed its status line; `sendSse` owns that path.
    if (!res.writableEnded) res.end();
    return;
  }
  const body = toErrorBody(error);
  const status = error instanceof LearningError ? error.status : 500;
  if (wantsHtml) {
    sendHtmlError(res, status, body);
  } else {
    sendJson(res, status, body, extraHeaders);
  }
}

// ── routing helpers ─────────────────────────────────────────────────────────

function isPublicPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return ROUTES.some(
    (route) =>
      route.auth === "public" && matchPattern(route.pattern, pathname) !== null,
  );
}

interface UiMatch {
  route: StaticUiSeam["routes"][number];
  params: Record<string, string>;
}

function matchUiRoute(
  ui: StaticUiSeam | undefined,
  pathname: string,
): UiMatch | null {
  if (ui === undefined) return null;
  for (const route of ui.routes) {
    const params = matchPattern(route.pattern, pathname);
    if (params !== null) return { route, params };
  }
  return null;
}

// ── the request handler ─────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const signal = new AbortController();
  res.on("close", () => {
    signal.abort();
  });

  let pathname: string;
  let wantsHtml = false;

  try {
    // 1. reject non-loopback peers (defence in depth; the listener is already
    //    bound to 127.0.0.1).
    assertLoopbackPeer(req.socket.remoteAddress);

    // 2. parseUrl (also rejects traversal-shaped raw paths).
    const parsed = parseRequestUrl(req.url ?? "/");
    pathname = parsed.pathname;

    const acceptsHtml = (headerValue(req.headers, "accept") ?? "")
      .toLowerCase()
      .includes("text/html");
    wantsHtml =
      !pathname.startsWith("/api") &&
      pathname !== "/session/bootstrap" &&
      (state.ui !== undefined || acceptsHtml);

    // 3. host allowlist, 4. origin on writes.
    assertHost(headerValue(req.headers, "host"), state.port);
    if (isStateChangingMethod(method)) {
      assertOrigin(headerValue(req.headers, "origin"), state.port);
    }

    // 5. session, except public entry points.
    if (!isPublicPath(pathname)) {
      assertSession(state.deps.session, headerValue(req.headers, "cookie"));
    }

    // 6. body, capped at 1 MiB.
    const body = await readBody(req, method, MAX_BODY_BYTES);

    const uiMatch = matchUiRoute(state.ui, pathname);
    const headers = requestHeaders(req.headers);

    // 7. route.
    const match = matchRoute(method, pathname);

    if (match !== null && "route" in match) {
      const handler = state.handlers.get(match.route.handler);
      if (handler === undefined) {
        throw new LearningError("internal_error", "处理器未注册", {
          handler: match.route.handler,
        });
      }
      const query = validateQuery(match.route.handler, parsed.query);
      const validatedBody = validateBody(match.route.handler, body);
      const response = await handler({
        params: match.params,
        query,
        body: validatedBody,
        headers,
        signal: signal.signal,
      });
      await sendRouteResponse(res, response, undefined, signal.signal);
      return;
    }

    if (match !== null && "allow" in match) {
      respondError(res, methodNotAllowed(), wantsHtml, {
        Allow: match.allow.join(", "),
      });
      return;
    }

    // 8. static UI seam; 9. otherwise not_found.
    if (uiMatch !== null && state.ui !== undefined) {
      if (method !== "GET") {
        respondError(res, methodNotAllowed(), wantsHtml, { Allow: "GET" });
        return;
      }
      const extraHeaders =
        pathname === "/"
          ? { "Set-Cookie": await mintSessionCookie(state.deps.session) }
          : undefined;
      // `RouteRequest` has no pathname field, so the matched path and pattern
      // are threaded through `params`; the seam needs them to dispatch its
      // static pages without a second, untyped lookup table.
      const response = await state.ui.handle({
        params: {
          ...uiMatch.params,
          path: pathname,
          pattern: uiMatch.route.pattern,
        },
        query: parsed.query,
        body,
        headers,
        signal: signal.signal,
      });
      if (response === null) throw notFound();
      await sendRouteResponse(res, response, extraHeaders, signal.signal);
      return;
    }

    throw notFound();
  } catch (error) {
    respondError(res, error, wantsHtml);
  }
}

// ── server lifecycle ────────────────────────────────────────────────────────

function bindHandlers(deps: AppDeps): Map<RouteHandlerKey, BoundHandler> {
  const handlers = new Map<RouteHandlerKey, BoundHandler>();
  for (const [key, factory] of registeredHandlers()) {
    handlers.set(key, factory(deps));
  }

  // Health and bootstrap are inline: they must work before any route module
  // is registered and cannot be overridden (they are the only public routes).
  handlers.set("health", () =>
    Promise.resolve({
      kind: "json",
      status: 200,
      body: {
        status: "ok",
        version: CODETRAIL_VERSION,
        upstreamCommit: UPSTREAM_COMMIT,
      },
    }),
  );
  handlers.set("bootstrap", async () => ({
    kind: "empty",
    status: 204,
    headers: { "Set-Cookie": await mintSessionCookie(deps.session) },
  }));
  return handlers;
}

/**
 * Starts the learning HTTP server. Binds `127.0.0.1` only; `port: 0` asks the
 * OS for a free port (the test suite uses this).
 */
export async function createLearningServer(
  options: ServerOptions,
): Promise<RunningServer> {
  assertLoopbackListenHost(LOOPBACK_HOST);
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw invalidInput({ field: "port" });
  }

  const state: ServerState = {
    port: 0,
    deps: options.deps,
    ui: options.ui,
    handlers: bindHandlers(options.deps),
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state);
  });

  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, LOOPBACK_HOST);
  });

  const address = server.address() as AddressInfo;
  state.port = address.port;

  return {
    url: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    port: address.port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

/**
 * Convenience alias used by the shared HTTP harness. It is the same server;
 * the name exists so tests can start "the learning server" without knowing
 * the factory's exact spelling.
 */
export async function startLearningServer(
  options: ServerOptions,
): Promise<RunningServer> {
  return createLearningServer(options);
}
