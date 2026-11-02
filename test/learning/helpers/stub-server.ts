/**
 * A real port-0 learning server with a stub route module and optional stub UI
 * seam (architecture §17.5).
 *
 * The HTTP core is driven through its actual listener — never by calling a
 * handler directly — so middleware order, headers and error funnelling are
 * exercised end to end.
 */

import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

import {
  createSessionStore,
  LOOPBACK_HOST,
  SESSION_COOKIE,
} from "../../../src/learning/api/auth.ts";
import { ROUTES, registerRouteModule } from "../../../src/learning/api/router.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";
import type {
  AppDeps,
  HandlerFactory,
  RouteHandlerKey,
  RouteModule,
  RouteRequest,
  RouteResponse,
  RunningServer,
  SessionStore,
  StaticUiSeam,
} from "../../../src/learning/contracts/index.ts";

/** An endpoint that echoes the request; enough for routing/validation tests. */
function echoHandler(key: RouteHandlerKey): HandlerFactory {
  return () => (req: RouteRequest): Promise<RouteResponse> =>
    Promise.resolve({
      kind: "json",
      status: 200,
      body: {
        handler: key,
        params: req.params,
        query: req.query,
        body: req.body ?? null,
      },
    });
}

const DEFAULT_HANDLERS = Object.fromEntries(
  ROUTES.map((route) => [route.handler, echoHandler(route.handler)]),
) as Record<RouteHandlerKey, HandlerFactory>;

export interface StubServerOptions {
  handlers?: Partial<Record<RouteHandlerKey, HandlerFactory>>;
  ui?: StaticUiSeam;
  paths?: DataPaths;
  /** Additional modules (used by duplicate-registration checks). */
  module?: RouteModule;
  routes?: RouteModule["routes"];
}

export interface StubServer {
  server: RunningServer;
  port: number;
  url: string;
  paths: DataPaths;
  session: SessionStore;
  /** The raw cookie value, without the `codetrail_session=` prefix. */
  token: string;
  /** `{ Cookie: "codetrail_session=<token>" }`, ready for a request. */
  cookie: Record<string, string>;
  close(): Promise<void>;
}

export async function startStubServer(
  options: StubServerOptions = {},
): Promise<StubServer> {
  const paths = options.paths ?? resolveDataPaths(process.env);
  const clock = createClock("2026-01-01T00:00:00.000Z");
  const session = createSessionStore(paths);
  const deps = {
    paths,
    clock,
    session,
    model: null,
  } as unknown as AppDeps;

  const module: RouteModule = options.module ?? {
    id: "ops",
    routes: options.routes ?? ROUTES,
    handlers: { ...DEFAULT_HANDLERS, ...(options.handlers ?? {}) },
  };
  registerRouteModule(module);

  const server = await createLearningServer({
    paths,
    port: 0,
    clock,
    deps,
    ui: options.ui,
  });

  const token = await session.ensureToken();
  const cookie = { Cookie: `${SESSION_COOKIE}=${token}` };

  return {
    server,
    port: server.port,
    url: server.url,
    paths,
    session,
    token,
    cookie,
    async close(): Promise<void> {
      await server.close();
    },
  };
}

export interface StubRequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface StubResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** A raw `node:http` request (so `Host`, `Origin` and bodies are controllable). */
export function httpRequest(
  port: number,
  options: StubRequestOptions = {},
): Promise<StubResponse> {
  const method = options.method ?? "GET";
  const path = options.path ?? "/";
  const headers = options.headers ?? {};

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: LOOPBACK_HOST,
        port,
        method,
        path,
        headers,
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export function jsonBody(response: StubResponse): unknown {
  return response.text === "" ? null : (JSON.parse(response.text) as unknown);
}

export function errorCode(response: StubResponse): unknown {
  const parsed = jsonBody(response);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const error = (parsed as { error?: { code?: unknown } }).error;
  return error?.code;
}
