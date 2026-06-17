/**
 * Query-result cache — the hot-path infrastructure CLAUDE.md promises (cache hit < 100ms).
 *
 * For a static file, the answer to a given query plan is stable until the source refreshes, so we
 * memoize plan → rows with a TTL. A hit serves without touching DuckDB AND without the billing
 * COUNT — the whole DuckDB round-trip disappears. This is named runtime state (invariant 3), not
 * hidden: the server is handed a cache explicitly.
 *
 * Correctness rules: the key is the exact normalized plan AND a namespace identifying the Tap/source
 * (so a shared cache can never serve one dataset's rows for another). Predicates are flattened to
 * tuples so semantically-equal plans key identically regardless of object key order.
 */
import type { QueryPlan } from "../core/query";

export type Row = Record<string, unknown>;

export interface RowCache {
  get(key: string): Row[] | undefined;
  set(key: string, rows: Row[]): void;
}

/** Bound on distinct cached plans — prevents unbounded memory growth under high-cardinality queries. */
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Stable cache key for a plan, namespaced to a specific Tap/source. The plan is a normalized,
 * validated structure; we flatten predicates/order to tuples so key order can't fragment the key.
 */
export function cacheKey(plan: QueryPlan, namespace = ""): string {
  return JSON.stringify([
    namespace,
    plan.columns,
    plan.predicates.map((p) => [p.field, p.op, p.value]),
    plan.order.map((o) => [o.field, o.dir]),
    plan.limit,
    plan.offset,
  ]);
}

/**
 * In-memory TTL cache with an LRU bound. Sufficient for local demos; a deploy swaps in redis/upstash
 * behind RowCache. Eviction: on overflow, drop the least-recently-used entry (Map keeps insertion
 * order; a hit re-inserts to mark it recent).
 */
export function memoryCache(
  ttlMs: number,
  now: () => number = Date.now,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): RowCache {
  const store = new Map<string, { rows: Row[]; expires: number }>();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        store.delete(key);
        return undefined;
      }
      store.delete(key); // re-insert to mark most-recently-used
      store.set(key, hit);
      return hit.rows;
    },
    set(key, rows) {
      store.delete(key);
      store.set(key, { rows, expires: now() + ttlMs });
      if (store.size > maxEntries) {
        const lru = store.keys().next().value; // oldest = least recently used
        if (lru !== undefined) store.delete(lru);
      }
    },
  };
}

/** Parse a config `Duration` ("24h", "15m", "1h30m") to milliseconds. */
export function parseDurationMs(duration: string): number {
  const unit: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const [, n, u] of duration.matchAll(/(\d+)([smhd])/g)) {
    total += Number(n) * (unit[u as string] ?? 0);
  }
  return total;
}
