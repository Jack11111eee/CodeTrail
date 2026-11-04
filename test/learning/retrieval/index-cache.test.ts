import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.js";
import { createIndexCache } from "../../../src/learning/retrieval/search.js";

/**
 * `IndexCache` is keyed per generation: an entry written for one generation
 * can never be read for another, `clear()` and TTL work, and `maxEntries`
 * bounds the whole cache.
 */

const G1 = "g_1" as GenerationId;
const G2 = "g_2" as GenerationId;

afterEach(() => {
  vi.useRealTimers();
});

describe("createIndexCache", () => {
  it("stores and retrieves values per generation", () => {
    const cache = createIndexCache();
    expect(cache.get(G1, "k")).toBeNull();
    cache.set(G1, "k", "value");
    expect(cache.get(G1, "k")).toBe("value");
    expect(cache.get(G2, "k")).toBeNull();
  });

  it("never leaks an entry across generations", () => {
    const cache = createIndexCache();
    cache.set(G1, "same-key", "one");
    cache.set(G2, "same-key", "two");
    expect(cache.get(G1, "same-key")).toBe("one");
    expect(cache.get(G2, "same-key")).toBe("two");

    cache.clear(G1);
    expect(cache.get(G1, "same-key")).toBeNull();
    expect(cache.get(G2, "same-key")).toBe("two");
  });

  it("clears everything without an argument", () => {
    const cache = createIndexCache();
    cache.set(G1, "a", 1);
    cache.set(G2, "b", 2);
    cache.clear();
    expect(cache.get(G1, "a")).toBeNull();
    expect(cache.get(G2, "b")).toBeNull();
  });

  it("expires an entry when its TTL elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = createIndexCache();
    cache.set(G1, "k", "value", 1_000);

    vi.advanceTimersByTime(999);
    expect(cache.get(G1, "k")).toBe("value");

    vi.advanceTimersByTime(1);
    expect(cache.get(G1, "k")).toBeNull();
  });

  it("treats a zero TTL as immediately expired", () => {
    const cache = createIndexCache();
    cache.set(G1, "k", "value", 0);
    expect(cache.get(G1, "k")).toBeNull();
  });

  it("evicts the least recently used entry past maxEntries", () => {
    const cache = createIndexCache(2);
    cache.set(G1, "a", 1);
    cache.set(G1, "b", 2);
    cache.set(G1, "c", 3);

    expect(cache.get(G1, "a")).toBeNull();
    expect(cache.get(G1, "b")).toBe(2);
    expect(cache.get(G1, "c")).toBe(3);
  });

  it("refreshes an entry's LRU position on read", () => {
    const cache = createIndexCache(2);
    cache.set(G1, "a", 1);
    cache.set(G1, "b", 2);
    expect(cache.get(G1, "a")).toBe(1);
    cache.set(G1, "c", 3);

    expect(cache.get(G1, "a")).toBe(1);
    expect(cache.get(G1, "b")).toBeNull();
    expect(cache.get(G1, "c")).toBe(3);
  });

  it("overwrites a key without growing the cache", () => {
    const cache = createIndexCache(1);
    cache.set(G1, "k", "first");
    cache.set(G1, "k", "second");
    expect(cache.get(G1, "k")).toBe("second");
  });
});
