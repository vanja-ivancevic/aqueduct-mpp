/**
 * Duration parsing — pure, lives in `core` so config validation can compare durations (e.g. enforce
 * `cache.ttl <= freshnessWindow`) without importing `runtime`. The runtime cache re-exports this.
 */

/** Parse a config `Duration` ("24h", "15m", "1h30m") to milliseconds. */
export function durationMs(duration: string): number {
  const unit: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const [, n, u] of duration.matchAll(/(\d+)([smhd])/g)) {
    total += Number(n) * (unit[u as string] ?? 0);
  }
  return total;
}
