import { describe, expect, it } from "vitest";
import type { QueryPlan } from "../core/query";
import { cacheKey, memoryCache, parseDurationMs } from "./cache";

const plan = (over: Partial<QueryPlan> = {}): QueryPlan => ({
  columns: ["name", "pop"],
  predicates: [{ field: "pop", op: "gte", value: 1000 }],
  order: [{ field: "pop", dir: "desc" }],
  limit: 10,
  offset: 0,
  ...over,
});

describe("cacheKey", () => {
  it("is stable for identical plans and distinct for different ones", () => {
    expect(cacheKey(plan())).toBe(cacheKey(plan()));
    expect(cacheKey(plan())).not.toBe(cacheKey(plan({ limit: 20 })));
    expect(cacheKey(plan())).not.toBe(cacheKey(plan({ offset: 5 })));
    expect(cacheKey(plan())).not.toBe(cacheKey(plan({ columns: ["name"] })));
  });

  it("namespaces keys so different Taps never collide on the same plan", () => {
    expect(cacheKey(plan(), "tapA")).not.toBe(cacheKey(plan(), "tapB"));
    expect(cacheKey(plan(), "tapA")).toBe(cacheKey(plan(), "tapA"));
  });
});

describe("memoryCache", () => {
  it("stores and returns rows within the TTL", () => {
    let t = 1000;
    const cache = memoryCache(5000, () => t);
    cache.set("k", [{ a: 1 }]);
    t = 4000;
    expect(cache.get("k")).toEqual([{ a: 1 }]);
  });

  it("evicts after the TTL elapses", () => {
    let t = 1000;
    const cache = memoryCache(5000, () => t);
    cache.set("k", [{ a: 1 }]);
    t = 6001; // past 1000 + 5000
    expect(cache.get("k")).toBeUndefined();
  });

  it("returns undefined for unknown keys", () => {
    const cache = memoryCache(5000, () => 0);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts the least-recently-used entry past the size cap", () => {
    const cache = memoryCache(60_000, () => 0, 2); // cap = 2
    cache.set("a", [{ n: 1 }]);
    cache.set("b", [{ n: 2 }]);
    cache.get("a"); // touch 'a' → 'b' is now LRU
    cache.set("c", [{ n: 3 }]); // overflow → evict 'b'
    expect(cache.get("a")).toEqual([{ n: 1 }]);
    expect(cache.get("c")).toEqual([{ n: 3 }]);
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("parseDurationMs", () => {
  it("parses single and compound durations", () => {
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("15m")).toBe(900_000);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
  });
});
