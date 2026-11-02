/**
 * Response writers: JSON, HTML and display-only SSE (architecture §14.4,
 * §16).
 *
 * Every HTML byte stream leaves through {@link sendHtml}, which is the only
 * place that sets the strict Content-Security-Policy from §16 (AC-SEC-05).
 * JSON errors go through the caller's single error funnel, so the body shape
 * `{error:{code,message,details?}}` is produced in exactly one place
 * (`toErrorBody`, §3.2).
 *
 * `sendSse` is deliberately passive: it serialises the iterable it is given
 * and never reads or advances job state. A reconnecting client is expected to
 * re-read `GET /api/jobs/:id`, which is the durable record (AC-API-12).
 */

import type { ServerResponse } from "node:http";

import { toErrorBody } from "../contracts/index.js";

/** The exact CSP required by architecture §16 (AC-SEC-05). */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; style-src 'self'; base-uri 'none'; form-action 'none'";

export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function isOpen(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

function applyHeaders(
  res: ServerResponse,
  headers: Readonly<Record<string, string>> | undefined,
): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

/** Writes a JSON response; headers are applied after the defaults. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  if (!isOpen(res)) return;
  const text = JSON.stringify(body) ?? "null";
  res.statusCode = status;
  res.setHeader("Content-Type", JSON_CONTENT_TYPE);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  applyHeaders(res, headers);
  res.end(text);
}

/**
 * Writes an HTML response. The CSP is applied last so a caller (including the
 * UI seam) cannot weaken it, and `nosniff` keeps a browser from reinterpreting
 * the body.
 */
export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers?: Readonly<Record<string, string>>,
): void {
  if (!isOpen(res)) return;
  res.statusCode = status;
  res.setHeader("Content-Type", HTML_CONTENT_TYPE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", Buffer.byteLength(html));
  applyHeaders(res, headers);
  // Force the policy even when the seam tried to supply its own.
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.end(html);
}

/** Writes a bodyless response (e.g. `204` bootstrap). */
export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers?: Readonly<Record<string, string>>,
): void {
  if (!isOpen(res)) return;
  res.statusCode = status;
  applyHeaders(res, headers);
  if (status !== 204 && status !== 304) {
    res.setHeader("Content-Length", "0");
  }
  res.end();
}

function eventName(value: unknown): string {
  if (typeof value === "object" && value !== null && "type" in value) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && /^[A-Za-z0-9_-]+$/u.test(type)) {
      return type;
    }
  }
  return "message";
}

function frame(name: string, data: unknown): string {
  const text = typeof data === "string" ? data : (JSON.stringify(data) ?? "null");
  const lines = text.split(/\r?\n/u).map((line) => `data: ${line}`);
  return `event: ${name}\n${lines.join("\n")}\n\n`;
}

interface NextResult {
  done: boolean;
  value?: unknown;
}

/**
 * Streams `events` as Server-Sent Events.
 *
 * - opens with `retry: 2000`
 * - writes one `event:`/`data:` frame per value (the frame name is the value's
 *   `type` when it has one, else `message`)
 * - always terminates with `event: done` when the client is still connected
 * - calls `iterator.return()` on client abort or completion so subscriptions
 *   are released
 * - converts a throw inside the generator into one `event: error` frame rather
 *   than a half-written response
 *
 * It never writes job state: the caller owns the iterable.
 */
export async function sendSse(
  res: ServerResponse,
  events: AsyncIterable<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (!isOpen(res)) return;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = signal?.aborted === true;
  let resolveAbort: (() => void) | null = null;
  const aborted = new Promise<NextResult>((resolve) => {
    resolveAbort = () => {
      resolve({ done: true });
    };
    if (closed) resolve({ done: true });
  });

  const onClose = (): void => {
    closed = true;
    resolveAbort?.();
  };
  const onAbort = (): void => {
    closed = true;
    resolveAbort?.();
  };
  res.on("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });

  const iterator = events[Symbol.asyncIterator]();
  try {
    if (!closed) res.write("retry: 2000\n\n");
    while (!closed) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done === true) break;
      if (closed || !isOpen(res)) break;
      res.write(frame(eventName(next.value), next.value));
    }
  } catch (error) {
    if (!closed && isOpen(res)) {
      res.write(frame("error", toErrorBody(error)));
    }
  } finally {
    res.off("close", onClose);
    signal?.removeEventListener("abort", onAbort);
    try {
      await iterator.return?.();
    } catch {
      // A generator that throws from its own finally must not escape: the
      // response is already committed and the client is gone or finishing.
    }
    if (!closed && isOpen(res)) {
      res.write(frame("done", {}));
      res.end();
    } else if (isOpen(res)) {
      res.end();
    }
  }
}
