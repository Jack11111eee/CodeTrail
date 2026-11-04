/**
 * Loopback auth harness for the security suites (architecture §14.2, §17.5).
 *
 * `api/server.ts` is a later wave, so these tests mount the auth guard chain on
 * a throwaway `node:http` server that binds port 0 on `127.0.0.1`. The handler
 * order mirrors the real chain: peer → Host → Origin (state-changing) →
 * session (non-public) → route.
 */

import http from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import {
  assertHost,
  assertLoopbackPeer,
  assertOrigin,
  assertSession,
  createSessionStore,
  isStateChangingMethod,
  LOOPBACK_HOST,
  mintSessionCookie,
  type SessionStore,
} from "../../../src/learning/api/auth.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import {
  LearningError,
  toErrorBody,
} from "../../../src/learning/contracts/index.ts";

export interface AuthHarness {
  url: string;
  port: number;
  store: SessionStore;
  close(): Promise<void>;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

export interface HttpRequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

function header(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.end(text);
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(html));
  res.end(html);
}

const LANDING_PAGE =
  "<!doctype html><html><head><title>Codetrail</title></head>" +
  "<body><h1>Codetrail</h1></body></html>";

async function handle(
  req: IncomingMessage,
  res: http.ServerResponse,
  port: number,
  store: SessionStore,
): Promise<void> {
  try {
    assertLoopbackPeer(req.socket.remoteAddress ?? undefined);
    const host = header(req.headers, "host");
    assertHost(host, port);
    const method = req.method ?? "GET";
    if (isStateChangingMethod(method)) {
      assertOrigin(header(req.headers, "origin"), port);
    }

    const pathname = new URL(
      req.url ?? "/",
      `http://${LOOPBACK_HOST}:${String(port)}`,
    ).pathname;

    if (pathname === "/api/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (pathname === "/" || pathname === "/session/bootstrap") {
      res.setHeader("Set-Cookie", await mintSessionCookie(store));
      if (pathname === "/") {
        sendHtml(res, 200, LANDING_PAGE);
      } else {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end();
      }
      return;
    }

    assertSession(store, header(req.headers, "cookie"));
    sendJson(res, 200, {
      path: pathname,
      method,
      host: host ?? null,
      origin: header(req.headers, "origin") ?? null,
    });
  } catch (error) {
    const status = error instanceof LearningError ? error.status : 500;
    sendJson(res, status, toErrorBody(error));
  }
}

/** Starts the guard server on a random `127.0.0.1` port. */
export async function startAuthHarness(
  paths: DataPaths = resolveDataPaths(process.env),
): Promise<AuthHarness> {
  const store = createSessionStore(paths);
  let port = 0;
  const server = http.createServer((req, res) => {
    void handle(req, res, port, store);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  port = address.port;

  return {
    url: `http://${LOOPBACK_HOST}:${String(port)}`,
    port,
    store,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

/**
 * A `node:http` request, so a test can override `Host` (forbidden in `fetch`)
 * and send arbitrary cookies.
 */
export function request(
  port: number,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
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
    req.end();
  });
}

/**
 * Sends a raw request over a TCP socket. Needed for HTTP/1.0 without a `Host`
 * header: every Node HTTP client adds one.
 */
export function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, LOOPBACK_HOST, () => {
      socket.write(requestText);
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => {
      resolve(text);
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy(new Error("raw request timed out"));
    });
  });
}

/** The token from a `Set-Cookie` response header, or `null`. */
export function cookieToken(headers: IncomingHttpHeaders): string | null {
  const setCookie = headers["set-cookie"];
  const list =
    setCookie === undefined
      ? []
      : Array.isArray(setCookie)
        ? setCookie
        : [setCookie];
  for (const headerValue of list) {
    const match = /(?:^|;\s*)codetrail_session=([^;]+)/u.exec(headerValue);
    if (match) return match[1];
  }
  return null;
}

/** Parses the numeric status from a raw HTTP response. */
export function rawStatus(text: string): number {
  const match = /^HTTP\/1\.[01] (\d{3})/u.exec(text);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}
