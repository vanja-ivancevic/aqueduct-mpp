import { describe, expect, it } from "vitest";
import { type TapConfig, markValidated, parseConfig } from "./config";

// Tests deliberately mutate deep, arbitrary fields of a clone to assert rejection. A loose alias
// keeps that legible without sprinkling casts; it's confined to this test file.
// biome-ignore lint/suspicious/noExplicitAny: intentional deep fixture mutation in tests
type Mut = any;

/** A minimal valid config (a parquet file Tap); tests tweak clones of it. */
function base(): unknown {
  return {
    version: 1,
    name: "nyc-311",
    source: {
      format: "parquet",
      location: { via: "url", ref: "https://example.com/311.parquet" },
      authEnv: null,
      contract: { determinism: "deterministic", freshnessWindow: "24h" },
    },
    schema: [
      { name: "id", type: "integer", required: true },
      { name: "borough", type: "string", required: true },
      { name: "created", type: "timestamp", required: true },
    ],
    query: {
      filters: [
        { field: "borough", ops: ["eq", "in"] },
        { field: "created", ops: ["gte", "lte"] },
      ],
      selectable: "*",
      sortable: ["created"],
      maxLimit: 1000,
      defaultLimit: 100,
    },
    pricing: {
      unit: "row",
      unitDefinition: "one 311 service-request record",
      unitPrice: "0.0001",
      currency: "0x20c0000000000000000000000000000000000000",
    },
    cache: { key: "queryHash", ttl: "1h" },
    evals: { golden: [], invariants: [], sampleSize: 5 },
    mpp: {
      intent: "session",
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      currency: "0x20c0000000000000000000000000000000000000",
      feePayer: true,
    },
  };
}

describe("parseConfig", () => {
  it("accepts a well-formed parquet Tap config", () => {
    expect(parseConfig(base()).ok).toBe(true);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(parseConfig({ ...(base() as object), surprise: true }).ok).toBe(false);
  });

  it("rejects a non-address recipient", () => {
    const c = base() as Mut;
    c.mpp.recipient = "not-an-address";
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "mpp.recipient")).toBe(true);
  });

  it("rejects a float unitPrice given as a number (money must be a decimal string)", () => {
    const c = base() as Mut;
    c.pricing.unitPrice = 0.0001;
    expect(parseConfig(c).ok).toBe(false);
  });

  it("rejects cache.ttl longer than the freshnessWindow (can't serve staler than advertised)", () => {
    const c = base() as Mut;
    c.cache.ttl = "48h";
    c.source.contract.freshnessWindow = "24h";
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "cache.ttl")).toBe(true);
  });

  it("accepts cache.ttl equal to the freshnessWindow", () => {
    const c = base() as Mut;
    c.cache.ttl = "24h";
    c.source.contract.freshnessWindow = "24h";
    expect(parseConfig(c).ok).toBe(true);
  });

  it("rejects an inline secret in authEnv (only env var names allowed)", () => {
    const c = base() as Mut;
    c.source.authEnv = "sk-live-abc123";
    expect(parseConfig(c).ok).toBe(false);
  });

  it("rejects an unsupported file format", () => {
    const c = base() as Mut;
    c.source.format = "xlsx";
    expect(parseConfig(c).ok).toBe(false);
  });

  it("rejects a filter on a field not in the schema", () => {
    const c = base() as Mut;
    c.query.filters.push({ field: "ghost", ops: ["eq"] });
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "query.filters")).toBe(true);
  });

  it("rejects a selectable column not in the schema", () => {
    const c = base() as Mut;
    c.query.selectable = ["id", "ghost"];
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "query.selectable")).toBe(true);
  });

  it("rejects a zero unitPrice (a paid Tap can't be free — amount-0 sessions are invalid)", () => {
    const c = base() as Mut;
    c.pricing.unitPrice = "0";
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "pricing.unitPrice")).toBe(true);
  });

  it("accepts a tiny sub-cent unitPrice (string check must not underflow to 0)", () => {
    const c = base() as Mut;
    c.pricing.unitPrice = "0.0000001";
    expect(parseConfig(c).ok).toBe(true);
  });

  it("rejects a price that is all zeros (e.g. 0.000)", () => {
    const c = base() as Mut;
    c.pricing.unitPrice = "0.000";
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "pricing.unitPrice")).toBe(true);
  });

  it("rejects defaultLimit greater than maxLimit", () => {
    const c = base() as Mut;
    c.query.defaultLimit = 5000;
    const r = parseConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path === "query.defaultLimit")).toBe(true);
  });

  it("applies declared defaults (feePayer, selectable)", () => {
    const r = parseConfig(base());
    if (r.ok) {
      expect(r.value.mpp.feePayer).toBe(true);
      expect(r.value.query.selectable).toBe("*");
    }
  });
});

describe("markValidated", () => {
  it("brands a parsed config so it is accepted where ValidatedConfig is required", () => {
    const r = parseConfig(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const served = markValidated(r.value);
      const takesValidated = (c: typeof served): TapConfig => c;
      expect(takesValidated(served).name).toBe("nyc-311");
    }
  });
});
