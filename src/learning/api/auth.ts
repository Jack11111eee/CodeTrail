/**
 * The local auth surface (architecture §14.3, §16).
 *
 * Three independent boundaries fail closed here:
 *
 * 1. **network** — the listener may only bind `127.0.0.1`; a socket whose peer
 *    is not loopback is refused.
 * 2. **host / origin** — a `Host` header outside the allowlist and a
 *    cross-site `Origin` on a state-changing request are rejected, before any
 *    session check runs.
 * 3. **session** — a 32-byte random token persisted in `session.json` (0600),
 *    delivered as an `HttpOnly; SameSite=Strict` cookie and compared in
 *    constant time.
 *
 * `SessionStore` itself is declared in `contracts/ports.ts` (§3.13) and is
 * only re-exported here; this module never redeclares a cross-component type.
 * The token is never logged, echoed in an error or placed in a response body.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { LearningError, errorMessageFor } from "../contracts/index.js";
import type { DataPaths, SessionStore } from "../contracts/index.js";

export type { SessionStore };

/** The session cookie name shared by the server, the UI and the test harness. */
export const SESSION_COOKIE = "codetrail_session";

/** The only address the learning server may bind (AC-SEC-01). */
export const LOOPBACK_HOST = "127.0.0.1";

/** 256 bits of entropy, hex-encoded to 64 characters. */
export const SESSION_TOKEN_BYTES = 32;

/** Host names that may appear in `Host` / `Origin` (architecture §14.3). */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
]);

/** A canonical token: 32 random bytes as lower-case hex. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

/** Methods for which `assertOrigin` applies (architecture §14.2). */
const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

function forbiddenOrigin(details?: Record<string, unknown>): LearningError {
  return new LearningError(
    "forbidden_origin",
    errorMessageFor("forbidden_origin", "zh"),
    details,
  );
}

function unauthorized(): LearningError {
  return new LearningError(
    "unauthorized",
    errorMessageFor("unauthorized", "zh"),
  );
}

/** Lower-cases a host name and drops one trailing dot (`localhost.`). */
function normalizeHostname(value: string): string {
  const lowered = value.trim().toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

/** Parses `Host`/authority into a name and port, or `null` when malformed. */
function splitAuthority(
  value: string,
): { hostname: string; port: number } | null {
  const authority = value.trim();
  if (authority === "") return null;
  // Bracketed IPv6, userinfo, paths and spaces can never be an allowed Host.
  if (/[[\]@/\\?#\s]/u.test(authority)) return null;

  const separator = authority.lastIndexOf(":");
  if (separator === -1) return null;
  const hostname = normalizeHostname(authority.slice(0, separator));
  const portText = authority.slice(separator + 1);
  if (!/^\d{1,5}$/u.test(portText)) return null;
  const port = Number.parseInt(portText, 10);
  if (port < 0 || port > 65535) return null;
  return { hostname, port };
}

/**
 * Rejects any `Host` header that is not exactly `127.0.0.1:<port>` or
 * `localhost:<port>` (AC-SEC-02). A missing or empty header is rejected as
 * well: there is no permissive fallback for HTTP/1.0 clients.
 */
export function assertHost(
  hostHeader: string | undefined | null,
  port: number,
): void {
  if (typeof hostHeader !== "string" || hostHeader.trim() === "") {
    throw forbiddenOrigin();
  }
  const authority = splitAuthority(hostHeader);
  if (authority === null) {
    throw forbiddenOrigin({ host: hostHeader });
  }
  if (!ALLOWED_HOSTNAMES.has(authority.hostname) || authority.port !== port) {
    throw forbiddenOrigin({ host: hostHeader });
  }
}

/**
 * Rejects a cross-site `Origin` on a state-changing request (AC-SEC-03).
 * An absent or empty `Origin` passes: same-origin form posts and non-browser
 * clients do not send one. `Origin: null` (opaque origin) never passes.
 */
export function assertOrigin(
  origin: string | undefined | null,
  port: number,
): void {
  if (origin === undefined || origin === null) return;
  const value = origin.trim();
  if (value === "") return;
  if (value.toLowerCase() === "null") {
    throw forbiddenOrigin({ origin: value });
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw forbiddenOrigin({ origin: value });
  }

  // An Origin is `scheme://host[:port]`; anything richer is not a browser
  // origin and must not be trusted.
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw forbiddenOrigin({ origin: value });
  }
  if (url.protocol !== "http:") {
    throw forbiddenOrigin({ origin: value });
  }
  if (!ALLOWED_HOSTNAMES.has(normalizeHostname(url.hostname))) {
    throw forbiddenOrigin({ origin: value });
  }
  const effectivePort = url.port === "" ? 80 : Number.parseInt(url.port, 10);
  if (effectivePort !== port) {
    throw forbiddenOrigin({ origin: value });
  }
}

/**
 * The loopback bind guard (AC-SEC-01). `undefined`/`null`/`""` means "use the
 * default", which is `127.0.0.1`. Every other value — including `localhost`,
 * `::1` and `0.0.0.0` — fails with `invalid_input`; no flag or environment
 * value can enable external listening.
 */
export function assertLoopbackListenHost(host?: string | null): void {
  if (host === undefined || host === null) return;
  const value = host.trim();
  if (value === "") return;
  if (value === LOOPBACK_HOST) return;
  throw new LearningError("invalid_input", "仅允许监听 127.0.0.1", {
    host: value,
  });
}

/** The loopback peer addresses Node reports for a local TCP connection. */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
]);

/**
 * Refuses a socket whose `remoteAddress` is not loopback (defence in depth for
 * `rejectNonLoopbackSocket`). A missing address (in-process or Unix socket)
 * cannot be attributed to a remote peer and is treated as local.
 */
export function assertLoopbackPeer(remoteAddress?: string | null): void {
  if (remoteAddress === undefined || remoteAddress === null) return;
  const address = remoteAddress.trim().toLowerCase();
  if (address === "") return;
  if (LOOPBACK_PEERS.has(address)) return;
  throw forbiddenOrigin({ remoteAddress: address });
}

/**
 * True for methods that mutate state and therefore must pass
 * {@link assertOrigin}. Exported so `api/server.ts` uses the same set.
 */
export function isStateChangingMethod(method: string | undefined): boolean {
  return STATE_CHANGING_METHODS.has((method ?? "GET").toUpperCase());
}

interface StoredSession {
  token: string;
}

function isHexToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * Reads a persisted token. Two shapes are accepted so a hand-written or
 * older `session.json` is not needlessly rotated: a bare hex token, or
 * `{"token": "<hex>"}`. Anything else is treated as corrupt and regenerated.
 */
function readTokenSync(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (isHexToken(trimmed)) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "token" in parsed &&
      isHexToken((parsed as StoredSession).token)
    ) {
      return (parsed as StoredSession).token;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * File-backed session store. The token is generated once, atomically written
 * with mode 0600, cached in memory and compared with SHA-256 +
 * `timingSafeEqual` so the comparison length is always 32 bytes.
 */
class FileSessionStore implements SessionStore {
  private token: string | null;
  private pending: Promise<string> | null = null;

  constructor(private readonly file: string) {
    this.token = readTokenSync(file);
    // Repair a permissive mode from an older install immediately; `ensureToken`
    // repeats this for the cases where the constructor cannot write.
    if (this.token !== null) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // A read-only data directory surfaces on the first mint instead.
      }
    }
  }

  async ensureToken(): Promise<string> {
    if (this.token !== null) {
      await this.ensureFile(this.token);
      return this.token;
    }
    if (this.pending === null) {
      this.pending = this.createToken();
    }
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  verify(candidate: string | undefined): boolean {
    if (this.token === null) return false;
    // Hash both sides first: `timingSafeEqual` requires equal lengths, and a
    // length-dependent early return would leak the token length.
    const expected = crypto.createHash("sha256").update(this.token).digest();
    const actual = crypto
      .createHash("sha256")
      .update(typeof candidate === "string" ? candidate : "")
      .digest();
    return crypto.timingSafeEqual(expected, actual);
  }

  cookieHeader(token: string): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
  }

  clearCookieHeader(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  private async createToken(): Promise<string> {
    const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    await this.writeFile(token);
    this.token = token;
    return token;
  }

  /** Re-creates a deleted token file and repairs a permissive mode. */
  private async ensureFile(token: string): Promise<void> {
    let mode: number | null;
    try {
      mode = fs.statSync(this.file).mode & 0o777;
    } catch {
      mode = null;
    }
    if (mode === null) {
      await this.writeFile(token);
      return;
    }
    if (mode !== 0o600) {
      await chmod(this.file, 0o600);
    }
  }

  private async writeFile(token: string): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const temp = path.join(
      directory,
      `.session-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.json`,
    );
    const body: StoredSession = { token };

    let handle: FileHandle | null = null;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(body)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temp, 0o600);
      await rename(temp, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temp).catch(() => undefined);
      throw new LearningError(
        "internal_error",
        "unable to write session.json",
        { cause: (error as Error).message },
      );
    }
  }
}

/** Builds the persisted session store rooted at `paths.session`. */
export function createSessionStore(paths: DataPaths): SessionStore {
  return new FileSessionStore(paths.session);
}

/**
 * Ensures a token exists and returns the `Set-Cookie` value for it. Used by
 * `GET /` and `GET /session/bootstrap`; the token itself stays server-side.
 */
export async function mintSessionCookie(store: SessionStore): Promise<string> {
  const token = await store.ensureToken();
  return store.cookieHeader(token);
}

/** Reads `name` out of a `Cookie` header, or `undefined`. */
function readCookie(
  cookieHeader: string | undefined | null,
  name: string,
): string | undefined {
  if (typeof cookieHeader !== "string" || cookieHeader === "") return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** Extracts the session token from a raw token or a full `Cookie` header. */
function extractCandidate(
  credential: string | undefined | null,
): string | undefined {
  if (typeof credential !== "string") return undefined;
  const value = credential.trim();
  if (value === "") return undefined;
  // A raw token has no `=`; anything else is a Cookie header.
  if (!value.includes("=")) return value;
  return readCookie(value, SESSION_COOKIE);
}

/**
 * Fails closed with 401 `unauthorized` unless `credential` carries a valid
 * session (AC-API-02). `credential` may be the raw token or the request's
 * `Cookie` header; `GET /api/health` is the only route that skips this.
 */
export function assertSession(
  store: SessionStore,
  credential: string | undefined | null,
): void {
  if (!store.verify(extractCandidate(credential))) {
    throw unauthorized();
  }
}
