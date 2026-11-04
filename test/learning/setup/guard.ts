import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { installPerTestDataDir } from "./tmp-data-dir.ts";

/**
 * Fail-closed offline guard (PRD §15.1, architecture §17.1/§17.5).
 *
 * Vitest loads this file as a setup module for every learning test. It patches
 * `fetch`, `http(s).request`/`.get`, `net.connect`/`createConnection`,
 * `tls.connect` and `dns.lookup` so a non-loopback target throws instead of
 * reaching the network. Loopback servers used by the suite (`127.0.0.1`,
 * `localhost`, `::1`) keep working.
 *
 * The guard is deliberately fail-closed: an unparseable URL, an unknown host
 * shape or an empty target all throw. A silently-open guard would let a test
 * hit the real network and make the suite non-deterministic.
 *
 * It also installs the per-test temporary `CODETRAIL_DATA_DIR`, because every
 * test must be isolated from `~/.codetrail` for the same reason.
 */

export class OfflineViolationError extends Error {
  readonly code = "offline_violation";
  readonly kind: string;
  readonly target: string;

  constructor(kind: string, target: string) {
    super(
      `offline_guard: blocked ${kind} to ${target} ` +
        "(only 127.0.0.1, localhost and ::1 are allowed)",
    );
    this.name = "OfflineViolationError";
    this.kind = kind;
    this.target = target;
  }
}

/** True when `host` names the loopback interface (or is the Node default). */
export function isLoopbackHost(host: string | undefined | null): boolean {
  // Node treats an absent host as `localhost` for every client API here.
  if (host === undefined || host === null || host.trim() === "") return true;
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized === "0:0:0:0:0:0:0:1" || normalized === "::ffff:127.0.0.1") {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return true;
  return false;
}

function stripPort(host: string): string {
  // `[::1]:4319` / `127.0.0.1:4319`; a bare IPv6 address has several colons.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(host);
  if (bracketed) return bracketed[1];
  const withPort = /^([^:]+):\d+$/u.exec(host);
  if (withPort) return withPort[1];
  return host;
}

function parseUrl(value: unknown): URL | null {
  try {
    if (value instanceof URL) return value;
    if (typeof value === "string") return new URL(value);
    if (typeof value === "object" && value !== null && "url" in value) {
      const url = value.url;
      if (typeof url === "string") return new URL(url);
      if (url instanceof URL) return url;
    }
  } catch {
    return null;
  }
  return null;
}

interface TargetCheck {
  allow: boolean;
  target: string;
}

function checkHost(
  host: string | undefined | null,
  fallback: string,
): TargetCheck {
  if (host === undefined || host === null)
    return { allow: true, target: fallback };
  return { allow: isLoopbackHost(host), target: host };
}

function checkUrlTarget(value: unknown): TargetCheck {
  const url = parseUrl(value);
  if (url === null) {
    return { allow: false, target: `unparseable ${String(value)}` };
  }
  return checkHost(url.hostname, url.href);
}

function checkFetchTarget(args: unknown[]): TargetCheck {
  return checkUrlTarget(args[0]);
}

function checkHttpTarget(args: unknown[]): TargetCheck {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    const url = parseUrl(first);
    if (url === null)
      return { allow: false, target: `unparseable ${String(first)}` };
    return checkHost(url.hostname, url.href);
  }
  if (typeof first === "object" && first !== null) {
    const options = first as Record<string, unknown>;
    if (typeof options.hostname === "string") {
      return checkHost(options.hostname, options.hostname);
    }
    if (typeof options.host === "string") {
      return checkHost(stripPort(options.host), options.host);
    }
    if (typeof options.href === "string") return checkUrlTarget(options.href);
  }
  // No host given: Node defaults to localhost.
  return { allow: true, target: "localhost" };
}

function checkNetTarget(args: unknown[]): TargetCheck {
  const first = args[0];
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? args[1] : undefined;
    return checkHost(host, "localhost");
  }
  if (typeof first === "string") {
    // A string first argument is a Unix-socket path, which is local.
    return { allow: true, target: first };
  }
  if (typeof first === "object" && first !== null) {
    const options = first as Record<string, unknown>;
    if (typeof options.host === "string")
      return checkHost(stripPort(options.host), options.host);
    if (typeof options.hostname === "string") {
      return checkHost(options.hostname, options.hostname);
    }
    if (typeof options.path === "string" && options.port === undefined) {
      return { allow: true, target: options.path };
    }
  }
  return { allow: true, target: "localhost" };
}

function checkDnsTarget(args: unknown[]): TargetCheck {
  const hostname = args[0];
  if (typeof hostname !== "string" || hostname === "") {
    return { allow: true, target: "localhost" };
  }
  return checkHost(hostname, hostname);
}

type AnyFunction = (...args: unknown[]) => unknown;

/** Wraps a client API so its first argument(s) are checked before delegating. */
function guard(
  original: AnyFunction,
  kind: string,
  checker: (args: unknown[]) => TargetCheck,
  { async = false }: { async?: boolean } = {},
): AnyFunction {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    const check = checker(args);
    if (!check.allow) {
      const error = new OfflineViolationError(kind, check.target);
      // Promise-based APIs reject; callback APIs throw synchronously.
      if (async) return Promise.reject(error);
      throw error;
    }
    return original.apply(this, args);
  };
}

interface PatchedSurfaces {
  fetch: typeof globalThis.fetch | undefined;
  httpRequest: typeof http.request;
  httpGet: typeof http.get;
  httpsRequest: typeof https.request;
  httpsGet: typeof https.get;
  netConnect: typeof net.connect;
  netCreateConnection: typeof net.createConnection;
  tlsConnect: typeof tls.connect;
  dnsLookup: typeof dns.lookup;
  dnsPromisesLookup: typeof dns.promises.lookup | undefined;
}

let installed: PatchedSurfaces | null = null;

/**
 * Installs the guard and returns a restore function. Idempotent: a second call
 * returns a no-op restorer because the surfaces are already patched.
 */
export function installOfflineGuard(): () => void {
  if (installed !== null) return () => {};

  const original: PatchedSurfaces = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
  };
  installed = original;

  if (typeof original.fetch === "function") {
    (globalThis as { fetch: unknown }).fetch = guard(
      original.fetch as unknown as AnyFunction,
      "fetch",
      checkFetchTarget,
      { async: true },
    );
  }

  const mutableHttp = http as unknown as { request: unknown; get: unknown };
  mutableHttp.request = guard(
    original.httpRequest as unknown as AnyFunction,
    "http.request",
    checkHttpTarget,
  );
  mutableHttp.get = guard(
    original.httpGet as unknown as AnyFunction,
    "http.get",
    checkHttpTarget,
  );

  const mutableHttps = https as unknown as { request: unknown; get: unknown };
  mutableHttps.request = guard(
    original.httpsRequest as unknown as AnyFunction,
    "https.request",
    checkHttpTarget,
  );
  mutableHttps.get = guard(
    original.httpsGet as unknown as AnyFunction,
    "https.get",
    checkHttpTarget,
  );

  const mutableNet = net as unknown as {
    connect: unknown;
    createConnection: unknown;
  };
  mutableNet.connect = guard(
    original.netConnect as unknown as AnyFunction,
    "net.connect",
    checkNetTarget,
  );
  mutableNet.createConnection = guard(
    original.netCreateConnection as unknown as AnyFunction,
    "net.connect",
    checkNetTarget,
  );

  (tls as unknown as { connect: unknown }).connect = guard(
    original.tlsConnect as unknown as AnyFunction,
    "tls.connect",
    checkNetTarget,
  );

  const mutableDns = dns as unknown as {
    lookup: unknown;
    promises: { lookup: unknown };
  };
  mutableDns.lookup = guard(
    original.dnsLookup as unknown as AnyFunction,
    "dns.lookup",
    checkDnsTarget,
  );
  if (original.dnsPromisesLookup !== undefined) {
    mutableDns.promises.lookup = guard(
      original.dnsPromisesLookup as unknown as AnyFunction,
      "dns.lookup",
      checkDnsTarget,
      { async: true },
    );
  }

  return function restore(): void {
    if (installed === null) return;
    if (typeof original.fetch === "function") {
      (globalThis as { fetch: unknown }).fetch = original.fetch;
    }
    mutableHttp.request = original.httpRequest;
    mutableHttp.get = original.httpGet;
    mutableHttps.request = original.httpsRequest;
    mutableHttps.get = original.httpsGet;
    mutableNet.connect = original.netConnect;
    mutableNet.createConnection = original.netCreateConnection;
    (tls as unknown as { connect: unknown }).connect = original.tlsConnect;
    mutableDns.lookup = original.dnsLookup;
    if (original.dnsPromisesLookup !== undefined) {
      mutableDns.promises.lookup = original.dnsPromisesLookup;
    }
    installed = null;
  };
}

/** True while the guard is active (useful for a self-check in a test). */
export function offlineGuardInstalled(): boolean {
  return installed !== null;
}

// The setup module installs both guarantees for the whole file it is loaded for.
installOfflineGuard();
installPerTestDataDir();
