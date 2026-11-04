/**
 * Loopback HTTP harness for the learning API (architecture §17.5).
 *
 * `startHarness()` attaches to an already-running server, starts one through an
 * injected factory, or (once the API exists) imports the learning server
 * module. Every request carries the session cookie minted by
 * `GET /session/bootstrap`, because the API rejects unauthenticated writes.
 *
 * The response is normalised to `{ status, headers, json, text }` so a test
 * never has to remember whether a body was JSON or text.
 */

export interface HarnessResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or `null` when the body was not JSON. */
  json: unknown;
  /** Raw body text. */
  text: string;
}

export interface HarnessServer {
  url: string;
  close?: () => Promise<void> | void;
}

export interface HarnessOptions {
  /** Attach to an existing server instead of starting one. */
  baseUrl?: string;
  /** Start the server yourself (the API suite passes `startLearningServer`). */
  start?: () => Promise<HarnessServer> | HarnessServer;
  /** Forwarded to the built-in server import when neither of the above is set. */
  serverOptions?: unknown;
}

export interface Harness {
  baseUrl: string;
  /** The session cookie value, once `bootstrap()` has run. */
  sessionToken: string | null;
  /** Mints the session cookie without attaching it to a request. */
  bootstrap(): Promise<string | null>;
  request(path: string, init?: RequestInit): Promise<HarnessResponse>;
  close(): Promise<void>;
}

const SESSION_COOKIE = "codetrail_session";

function cookieValue(setCookieHeaders: string[]): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`, "u").exec(
      header,
    );
    if (match) return match[1];
  }
  return null;
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readResponse(response: Response): Promise<HarnessResponse> {
  const text = await response.text();
  const json = parseJson(text);
  return { status: response.status, headers: response.headers, json, text };
}

async function startBuiltInServer(
  serverOptions: unknown,
): Promise<HarnessServer> {
  // Computed specifier: the API module is created by a later wave, and a
  // literal import would fail type-checking before it exists.
  const specifier = "../../../src/learning/api/server.ts";
  const module = (await import(specifier)) as {
    startLearningServer?: (options?: unknown) => Promise<HarnessServer>;
  };
  if (typeof module.startLearningServer !== "function") {
    throw new Error(
      "src/learning/api/server.ts does not export startLearningServer",
    );
  }
  return module.startLearningServer(serverOptions);
}

export async function startHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  let server: HarnessServer | null = null;
  let baseUrl: string;

  if (options.baseUrl !== undefined) {
    baseUrl = options.baseUrl.replace(/\/$/u, "");
  } else if (options.start !== undefined) {
    server = await options.start();
    baseUrl = server.url.replace(/\/$/u, "");
  } else {
    server = await startBuiltInServer(options.serverOptions);
    baseUrl = server.url.replace(/\/$/u, "");
  }

  let sessionToken: string | null = null;

  const bootstrap = async (): Promise<string | null> => {
    const response = await fetch(`${baseUrl}/session/bootstrap`, {
      method: "GET",
      redirect: "manual",
    });
    const setCookie =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""];
    await response.text();
    sessionToken = cookieValue(setCookie);
    return sessionToken;
  };

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<HarnessResponse> => {
    if (sessionToken === null) await bootstrap();
    const headers = new Headers(init.headers);
    if (sessionToken !== null && !headers.has("Cookie")) {
      headers.set("Cookie", `${SESSION_COOKIE}=${sessionToken}`);
    }
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    return readResponse(response);
  };

  return {
    baseUrl,
    get sessionToken() {
      return sessionToken;
    },
    bootstrap,
    request,
    async close(): Promise<void> {
      if (server !== null && typeof server.close === "function") {
        await server.close();
      }
    },
  };
}
