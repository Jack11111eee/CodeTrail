/**
 * Shared plumbing for the level-8 integration suites.
 *
 * The three branches under test here are `jobs/publish` (runner + publisher +
 * usage), `qa` (tools/context/answer/conversations) and `ui` (server, static
 * seam, pages, renderers, request validation). They only meet in the real
 * process: a job writes SQLite rows and sealed lesson files, the static seam
 * reads them back, and the browser bundle posts the selection the request
 * validator and the conversation service must agree on.
 *
 * This helper starts the *real* learning server (`api/server.ts`) with the
 * production static-UI seam (`api/static.ts`) and only the route modules a
 * test asks for. Nothing here fabricates rendered HTML: every page comes out
 * of the merged renderer.
 */

import { createSessionStore } from "../../../src/learning/api/auth.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import type {
  AppDeps,
  RouteModule,
  RunningServer,
  SessionStore,
} from "../../../src/learning/contracts/index.ts";

const SESSION_COOKIE = "codetrail_session";

export interface UiServerResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface UiServer {
  url: string;
  port: number;
  cookie: string;
  close(): Promise<void>;
  get(
    path: string,
    headers?: Record<string, string>,
  ): Promise<UiServerResponse>;
  request(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<UiServerResponse>;
}

function sessionCookie(headers: Headers): string {
  const setCookie =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  for (const header of setCookie) {
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`, "u").exec(
      header,
    );
    if (match !== null) return `${SESSION_COOKIE}=${match[1]}`;
  }
  throw new Error("session bootstrap did not set the session cookie");
}

/**
 * Builds the `AppDeps` surface the static seam actually consumes from a
 * harness. The remaining ports are deliberately absent: if a page starts
 * depending on one, the test fails loudly instead of silently stubbing it.
 */
export function uiDepsFrom(harness: {
  paths: AppDeps["paths"];
  clock: AppDeps["clock"];
  db: AppDeps["db"];
  repos: AppDeps["repos"];
  session?: SessionStore;
}): AppDeps {
  const session = harness.session ?? createSessionStore(harness.paths);
  return {
    paths: harness.paths,
    clock: harness.clock,
    db: harness.db,
    repos: harness.repos,
    session,
  } as unknown as AppDeps;
}

export async function startUiServer(
  deps: AppDeps,
  options: { modules?: RouteModule[] } = {},
): Promise<UiServer> {
  for (const module of options.modules ?? []) registerRouteModule(module);

  const ui = createStaticUi(deps);
  const server: RunningServer = await createLearningServer({
    paths: deps.paths,
    port: 0,
    clock: deps.clock,
    deps,
    ui,
  });

  const bootstrap = await fetch(`${server.url}/session/bootstrap`, {
    method: "GET",
    redirect: "manual",
  });
  const cookie = sessionCookie(bootstrap.headers);
  await bootstrap.text();

  const request: UiServer["request"] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  };

  return {
    url: server.url,
    port: server.port,
    cookie,
    close: () => server.close(),
    get: (path, headers) => request(path, { method: "GET", headers }),
    request,
  };
}

/** Counts occurrences of a `data-testid` marker in server-rendered HTML. */
export function countTestId(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1;
}

/** Returns the value of a `data-*` attribute on the first matching tag. */
export function attributeOf(
  html: string,
  marker: string,
  attribute: string,
): string | null {
  const index = html.indexOf(marker);
  if (index === -1) return null;
  const open = html.lastIndexOf("<", index);
  const close = html.indexOf(">", index);
  if (open === -1 || close === -1) return null;
  const tag = html.slice(open, close);
  const match = new RegExp(`${attribute}="([^"]*)"`, "u").exec(tag);
  return match === null ? null : match[1];
}
