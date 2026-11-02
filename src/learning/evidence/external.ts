/**
 * Allowlisted external documents with SSRF defence (architecture §8.2).
 *
 * Only `https` URLs on `ALLOWED_EXTERNAL_HOSTS` are fetched. The resolved IP
 * is re-checked after DNS — and after every redirect hop — so a hostname that
 * resolves (or rebinds) to a private address is refused. At most two redirects
 * are followed, each re-validated. The response is capped at 2 MiB, reduced
 * from HTML to text, and cached under `<data>/external/<contentHash>` only
 * after every check has passed.
 *
 * `ExternalFetchRequest`, `ExternalFetchResult` and `ExternalDocService` are
 * declared in `contracts/ports.ts`; this module implements the service and
 * re-exports the types.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { lookup } from "node:dns/promises";

import { LearningError } from "../contracts/index.js";
import type {
  Clock,
  DataPaths,
  ExternalDocService,
  ExternalFetchRequest,
  ExternalFetchResult,
} from "../contracts/index.js";
import { sliceHash } from "../contracts/index.js";
import {
  assertPublicUrl,
  ALLOWED_EXTERNAL_HOSTS,
  isBlockedAddress,
} from "./ssrf.js";

export type { ExternalDocService, ExternalFetchRequest, ExternalFetchResult };
export { ALLOWED_EXTERNAL_HOSTS };

/** 2 MiB — the hard ceiling for one external document (§8.2). */
export const MAX_EXTERNAL_BYTES = 2 * 1024 * 1024;

/** At most two re-validated redirect hops. */
export const MAX_REDIRECT_HOPS = 2;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

const CACHE_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface ExternalDocServiceDeps {
  paths: DataPaths;
  clock: Clock;
  /** DNS seam; defaults to `dns.promises.lookup`. Tests always inject one. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** HTTP seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function unavailable(
  message: string,
  details?: Record<string, unknown>,
): LearningError {
  return new LearningError("external_source_unavailable", message, details);
}

function failure(
  reason: Extract<ExternalFetchResult, { ok: false }>["reason"],
): ExternalFetchResult {
  return { ok: false, status: "source_missing", reason };
}

function missingHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu,
    (match, code: string) => {
      if (code.startsWith("#")) {
        const hex = code[1]?.toLowerCase() === "x";
        const digits = hex ? code.slice(2) : code.slice(1);
        const parsed = Number.parseInt(digits, hex ? 16 : 10);
        return Number.isFinite(parsed) && parsed > 0 && parsed <= 0x10ffff
          ? String.fromCodePoint(parsed)
          : match;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    },
  );
}

function extractTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  if (title !== null) {
    const text = decodeEntities(title[1].replace(/<[^>]+>/gu, " ")).trim();
    if (text !== "") {
      return text;
    }
  }
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/iu.exec(html);
  if (heading !== null) {
    const text = decodeEntities(heading[1].replace(/<[^>]+>/gu, " ")).trim();
    if (text !== "") {
      return text;
    }
  }
  return null;
}

/** Conservative HTML → text: drop scripts/styles, tags and entities. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isTextualContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (value === "") {
    return true;
  }
  if (value.startsWith("text/")) {
    return true;
  }
  return (
    value.includes("html") ||
    value.includes("xml") ||
    value.includes("json") ||
    value.includes("javascript")
  );
}

/** Strips the fragment so the stored URL is the canonical document address. */
function canonicalize(url: URL): string {
  const canonical = new URL(url.href);
  canonical.hash = "";
  return canonical.href;
}

export function createExternalDocService(
  deps: ExternalDocServiceDeps,
): ExternalDocService {
  const { paths } = deps;
  const fetchImpl: typeof fetch = deps.fetchImpl ?? globalThis.fetch;

  async function resolveAddresses(url: URL): Promise<string[]> {
    const host = missingHostname(url.hostname);
    if (host === "" || isIP(host) !== 0) {
      return [];
    }
    if (deps.resolve !== undefined) {
      return deps.resolve(host);
    }
    const results = await lookup(host, { all: true });
    return results.map((entry) => entry.address);
  }

  /**
   * Resolves and checks the address for `url`. Returns `"network"` when DNS
   * fails, throws `external_source_unavailable` when the address is blocked.
   */
  async function guardResolvedAddress(
    url: URL,
    reason: "blocked_host" | "redirect_blocked",
  ): Promise<"ok" | "network"> {
    let addresses: string[];
    try {
      addresses = await resolveAddresses(url);
    } catch {
      return "network";
    }
    if (addresses.length === 0) {
      return "network";
    }
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw unavailable("外部资料暂不可用", {
          url: url.href,
          reason,
          detail: "blocked_address",
          address,
        });
      }
    }
    return "ok";
  }

  async function readCapped(
    response: Response,
  ): Promise<{ bytes: Uint8Array } | { tooLarge: true }> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > MAX_EXTERNAL_BYTES) {
        return { tooLarge: true };
      }
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_EXTERNAL_BYTES) {
      return { tooLarge: true };
    }
    return { bytes: new Uint8Array(buffer) };
  }

  async function writeCache(contentHash: string, text: string): Promise<void> {
    await mkdir(paths.external, { recursive: true, mode: 0o700 });
    await writeFile(path.join(paths.external, contentHash), text, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return {
    async fetchExact(req: ExternalFetchRequest): Promise<ExternalFetchResult> {
      let current: URL;
      try {
        current = new URL(req.url);
      } catch {
        throw unavailable("外部资料暂不可用", {
          url: req.url,
          reason: "blocked_host",
          detail: "invalid_url",
        });
      }

      assertPublicUrl(current);

      let hops = 0;
      let response: Response;
      for (;;) {
        const guard = await guardResolvedAddress(
          current,
          hops === 0 ? "blocked_host" : "redirect_blocked",
        );
        if (guard === "network") {
          return failure("network");
        }

        try {
          response = await fetchImpl(current, { redirect: "manual" });
        } catch {
          return failure("network");
        }

        if (!REDIRECT_STATUSES.has(response.status)) {
          break;
        }

        if (hops >= MAX_REDIRECT_HOPS) {
          throw unavailable("外部资料暂不可用", {
            url: current.href,
            reason: "redirect_blocked",
            detail: "too_many_redirects",
          });
        }

        const location = response.headers.get("location");
        if (location === null || location.trim() === "") {
          return failure("network");
        }

        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw unavailable("外部资料暂不可用", {
            url: current.href,
            reason: "redirect_blocked",
            detail: "invalid_location",
          });
        }

        // Re-validate the scheme and allowlist here; the resolved address is
        // checked at the top of the next iteration, i.e. per hop.
        try {
          assertPublicUrl(next);
        } catch (error) {
          const details =
            error instanceof LearningError ? error.details : undefined;
          throw unavailable("外部资料暂不可用", {
            ...details,
            url: next.href,
            reason: "redirect_blocked",
            detail: "host_not_allowed",
            from: current.href,
          });
        }
        hops += 1;
        current = next;
      }

      if (response.status === 401 || response.status === 403) {
        return failure("auth_required");
      }
      if (response.status === 402) {
        return failure("paywalled");
      }
      if (response.status === 404 || response.status === 410) {
        return failure("not_found");
      }
      if (response.status < 200 || response.status >= 300) {
        return failure("network");
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!isTextualContentType(contentType)) {
        return failure("non_text");
      }

      let body: { bytes: Uint8Array } | { tooLarge: true };
      try {
        body = await readCapped(response);
      } catch {
        return failure("network");
      }
      if ("tooLarge" in body) {
        return failure("too_large");
      }

      const raw = new TextDecoder("utf-8").decode(body.bytes);
      const looksHtml =
        contentType.toLowerCase().includes("html") ||
        /<html[\s>]/iu.test(raw.slice(0, 2048));
      const title = looksHtml ? extractTitle(raw) : null;
      const text = looksHtml ? htmlToText(raw) : raw;

      const contentHash = sliceHash(text);
      await writeCache(contentHash, text);

      const canonicalUrl = canonicalize(current);
      const hostLabel = `${current.hostname}${current.pathname}`;
      return {
        ok: true,
        canonicalUrl,
        versionOrRetrievedAt:
          req.expectedVersion !== undefined && req.expectedVersion.trim() !== ""
            ? req.expectedVersion
            : deps.clock.now().toISOString(),
        locator: req.locator,
        contentHash,
        title: title ?? hostLabel,
        text,
      };
    },

    async cached(contentHash: string): Promise<string | null> {
      if (!CACHE_KEY_PATTERN.test(contentHash)) {
        return null;
      }
      try {
        return await readFile(path.join(paths.external, contentHash), "utf8");
      } catch {
        return null;
      }
    },
  };
}
