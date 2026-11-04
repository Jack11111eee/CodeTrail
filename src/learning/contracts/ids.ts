import type { RepoIdentity } from "./refs.js";
import type { SourceKind } from "./sources.js";

/**
 * Branded identifiers.
 *
 * Every id is a branded string so that a `RepoId` can never be passed where a
 * `GenerationId` is expected. The runtime values are plain strings with a stable
 * prefix (see `ID_PREFIX`); branding is erased at compile time.
 */
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type RepoId = string & { readonly __brand: "RepoId" };
export type GenerationId = string & { readonly __brand: "GenerationId" };
export type LessonId = string & { readonly __brand: "LessonId" };
export type SourceId = string & { readonly __brand: "SourceId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type JobId = string & { readonly __brand: "JobId" };
export type ChangeEventId = string & { readonly __brand: "ChangeEventId" };
export type TermId = string & { readonly __brand: "TermId" };

export const ID_PREFIX: Readonly<
  Record<
    | "project"
    | "repo"
    | "generation"
    | "lesson"
    | "source"
    | "conversation"
    | "message"
    | "job"
    | "event"
    | "term",
    string
  >
> = {
  project: "p_",
  repo: "r_",
  generation: "g_",
  lesson: "l_",
  source: "s_",
  conversation: "c_",
  message: "m_",
  job: "j_",
  event: "e_",
  term: "t_",
};

/*
 * A synchronous, dependency-free SHA-256 implementation.
 *
 * Contracts may not import `node:crypto` (the leaf rule forbids every `node:*`
 * module) and may not import a package value, yet the id and key formulas are
 * synchronous. `TextEncoder` is a standard global in both Node and browsers, so
 * this module stays importable from a browser bundle while producing exactly the
 * bytes `createHash("sha256")` produces.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;

  const view = new DataView(data.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(offset + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + ch + K[t] + w[t]) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return (
    hex8(h0) +
    hex8(h1) +
    hex8(h2) +
    hex8(h3) +
    hex8(h4) +
    hex8(h5) +
    hex8(h6) +
    hex8(h7)
  );
}

/** Stable 64-bit-collision-safe-enough suffix: first 16 lowercase hex chars. */
export function idSuffix(input: string): string {
  return sha256Hex(input).slice(0, 16);
}

export function repoIdFromIdentity(identity: RepoIdentity): RepoId {
  return `${ID_PREFIX.repo}${idSuffix(identity)}` as RepoId;
}

export function generationIdFromCacheKey(cacheKey: string): GenerationId {
  return `${ID_PREFIX.generation}${idSuffix(cacheKey)}` as GenerationId;
}

export function jobIdFromDedupeKey(dedupeKey: string): JobId {
  return `${ID_PREFIX.job}${idSuffix(dedupeKey)}` as JobId;
}

export function changeEventIdFromKey(eventKey: string): ChangeEventId {
  return `${ID_PREFIX.event}${idSuffix(eventKey)}` as ChangeEventId;
}

function randomUuidHex16(): string {
  const holder = globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
  };
  const uuid = holder.crypto?.randomUUID?.();
  if (typeof uuid !== "string") {
    throw new Error("crypto.randomUUID is unavailable");
  }
  return uuid.replace(/-/g, "").slice(0, 16).toLowerCase();
}

export function newProjectId(): ProjectId {
  return `${ID_PREFIX.project}${randomUuidHex16()}` as ProjectId;
}

export function newConversationId(): ConversationId {
  return `${ID_PREFIX.conversation}${randomUuidHex16()}` as ConversationId;
}

export function newMessageId(): MessageId {
  return `${ID_PREFIX.message}${randomUuidHex16()}` as MessageId;
}

export function newLessonId(seed: string): LessonId {
  return `${ID_PREFIX.lesson}${idSuffix(seed)}` as LessonId;
}

export function sourceIdOf(kind: SourceKind, identity: string): SourceId {
  return `${ID_PREFIX.source}${idSuffix(`${kind}:${identity}`)}` as SourceId;
}
