/**
 * SSRF defence for external documents (architecture §8.2, §16).
 *
 * `assertPublicUrl` is the cheap, synchronous gate every fetch passes before a
 * socket is opened. `isBlockedAddress` is the authoritative check applied to
 * the *resolved* IP after DNS — and again on every redirect hop — so a
 * hostname that rebinds between the allowlist lookup and the connection is
 * still refused.
 *
 * The allowlist is deliberately static: only official documentation and
 * primary papers are readable, never arbitrary pages (PRD §8).
 */

import { isIP } from "node:net";

import { LearningError } from "../contracts/index.js";

/**
 * Hosts an external document may come from. Kept as an array so callers can
 * inspect it; membership checks use the frozen set below.
 */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = Object.freeze([
  "docs.python.org",
  "docs.oracle.com",
  "developer.mozilla.org",
  "nodejs.org",
  "vuejs.org",
  "typescriptlang.org",
  "pydantic-docs.helpmanual.io",
  "docs.pydantic.dev",
  "arxiv.org",
  "doi.org",
  "github.com",
]);

const ALLOWED_HOST_SET: ReadonlySet<string> = new Set(ALLOWED_EXTERNAL_HOSTS);

function unavailable(
  message: string,
  details?: Record<string, unknown>,
): LearningError {
  return new LearningError("external_source_unavailable", message, details);
}

/** Lower-cases and drops a trailing dot / surrounding IPv6 brackets. */
function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return bytes;
}

function isBlockedIPv4(bytes: readonly number[]): boolean {
  const [a, b, c] = bytes;
  if (a === 0) {
    return true;
  } // 0.0.0.0/8 "this network"
  if (a === 10) {
    return true;
  } // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  } // 100.64.0.0/10 CGNAT
  if (a === 127) {
    return true;
  } // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) {
    return true;
  } // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  } // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) {
    return true;
  } // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) {
    return true;
  } // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) {
    return true;
  } // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  } // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) {
    return true;
  } // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) {
    return true;
  } // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) {
    return true;
  } // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Parses an IPv6 address into 16 bytes; `null` when it is not IPv6. */
function parseIPv6(raw: string): number[] | null {
  let input = raw.trim().toLowerCase();
  const zone = input.indexOf("%");
  if (zone !== -1) {
    input = input.slice(0, zone);
  }
  input = input.replace(/^\[/u, "").replace(/\]$/u, "");

  const halves = input.split("::");
  if (halves.length > 2) {
    return null;
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups = part.split(":");
    const words: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.includes(".")) {
        if (index !== groups.length - 1) {
          return null;
        }
        const embedded = parseIPv4(group);
        if (embedded === null) {
          return null;
        }
        words.push((embedded[0] << 8) | embedded[1]);
        words.push((embedded[2] << 8) | embedded[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(group)) {
          return null;
        }
        words.push(Number.parseInt(group, 16));
      }
    }
    return words;
  };

  let words: number[];
  if (halves.length === 1) {
    const only = parseGroups(halves[0]);
    if (only === null || only.length !== 8) {
      return null;
    }
    words = only;
  } else {
    const left = parseGroups(halves[0]);
    const right = parseGroups(halves[1]);
    if (left === null || right === null) {
      return null;
    }
    const missing = 8 - left.length - right.length;
    if (missing < 1) {
      return null;
    }
    words = [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const bytes: number[] = [];
  for (const word of words) {
    bytes.push((word >>> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

function isBlockedIPv6(bytes: readonly number[]): boolean {
  const zeroPrefix = (length: number): boolean =>
    bytes.slice(0, length).every((byte) => byte === 0);

  if (zeroPrefix(16)) {
    return true;
  } // :: unspecified
  if (zeroPrefix(15) && bytes[15] === 1) {
    return true;
  } // ::1 loopback

  // IPv4-mapped ::ffff:0:0/96
  if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIPv4(bytes.slice(12));
  }
  // IPv4-compatible ::/96 (deprecated, still routable on some stacks)
  if (zeroPrefix(12)) {
    return isBlockedIPv4(bytes.slice(12));
  }
  // NAT64 64:ff9b::/96
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return isBlockedIPv4(bytes.slice(12));
  }
  // Unique local addresses fc00::/7
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true;
  }
  // Link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return true;
  }
  // Multicast ff00::/8
  if (bytes[0] === 0xff) {
    return true;
  }
  return false;
}

/**
 * True for every address an external fetch must never reach: loopback,
 * private, link-local, CGNAT, multicast/reserved and the IPv6 equivalents.
 * An unparseable string is treated as blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.trim() === "") {
    return true;
  }
  const value = ip.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  const version = isIP(value);
  if (version === 4) {
    const bytes = parseIPv4(value);
    return bytes === null ? true : isBlockedIPv4(bytes);
  }
  if (version === 6) {
    const bytes = parseIPv6(value);
    return bytes === null ? true : isBlockedIPv6(bytes);
  }
  // A hostname is not an address: the caller resolves first, then re-checks.
  return true;
}

/**
 * Synchronous URL gate: `https` only, and the host must be on the static
 * allowlist. Literal IPs are never allowlisted.
 */
export function assertPublicUrl(url: URL): void {
  if (url.protocol !== "https:") {
    throw unavailable("外部资料暂不可用", {
      url: url.href,
      reason: "blocked_host",
      detail: "https_required",
    });
  }

  const host = normalizeHostname(url.hostname);
  if (host === "") {
    throw unavailable("外部资料暂不可用", {
      url: url.href,
      reason: "blocked_host",
      detail: "missing_host",
    });
  }

  if (isIP(host) !== 0) {
    throw unavailable("外部资料暂不可用", {
      url: url.href,
      reason: "blocked_host",
      detail: "ip_literal",
    });
  }

  if (!ALLOWED_HOST_SET.has(host)) {
    throw unavailable("外部资料暂不可用", {
      url: url.href,
      reason: "blocked_host",
      detail: "host_not_allowed",
    });
  }
}
