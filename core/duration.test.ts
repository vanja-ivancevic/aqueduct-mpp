import { describe, expect, it } from "vitest";
import { durationMs } from "./duration";

describe("durationMs", () => {
  it("parses single units", () => {
    expect(durationMs("1s")).toBe(1_000);
    expect(durationMs("15m")).toBe(900_000);
    expect(durationMs("1h")).toBe(3_600_000);
    expect(durationMs("24h")).toBe(86_400_000);
    expect(durationMs("1d")).toBe(86_400_000);
  });

  it("sums compound durations", () => {
    expect(durationMs("1h30m")).toBe(5_400_000);
    expect(durationMs("2d12h")).toBe(216_000_000);
  });

  it("orders correctly for the cache.ttl <= freshnessWindow check", () => {
    expect(durationMs("1h") <= durationMs("24h")).toBe(true);
    expect(durationMs("48h") <= durationMs("24h")).toBe(false);
  });
});
