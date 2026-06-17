import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";
import { planQuery } from "./query";

/** A validated config to plan against (reuses the parquet Tap shape). */
function config() {
  const r = parseConfig({
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
      { name: "secret", type: "string", required: false },
    ],
    query: {
      filters: [
        { field: "borough", ops: ["eq", "in"] },
        { field: "created", ops: ["gte", "lte"] },
      ],
      selectable: ["id", "borough", "created"], // note: "secret" intentionally NOT selectable
      sortable: ["created"],
      maxLimit: 1000,
      defaultLimit: 100,
    },
    pricing: {
      unit: "row",
      unitDefinition: "one record",
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
  });
  if (!r.ok) throw new Error("fixture config invalid");
  return r.value;
}

describe("planQuery — happy path", () => {
  it("empty request → default columns (selectable only) + default limit + no predicates", () => {
    const r = planQuery(config(), {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.columns).toEqual(["id", "borough", "created"]); // NOT "*", and excludes "secret"
      expect(r.value.predicates).toEqual([]);
      expect(r.value.limit).toBe(100);
      expect(r.value.offset).toBe(0);
    }
  });

  it("builds a validated plan from a full request", () => {
    const r = planQuery(config(), {
      select: ["id", "borough"],
      filters: [{ field: "borough", op: "in", value: ["BRONX", "QUEENS"] }],
      sort: [{ field: "created", dir: "desc" }],
      limit: 50,
      offset: 10,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.columns).toEqual(["id", "borough"]);
      expect(r.value.predicates).toEqual([
        { field: "borough", op: "in", value: ["BRONX", "QUEENS"] },
      ]);
      expect(r.value.order).toEqual([{ field: "created", dir: "desc" }]);
      expect(r.value.limit).toBe(50);
      expect(r.value.offset).toBe(10);
    }
  });

  it("clamps limit to maxLimit", () => {
    const r = planQuery(config(), { limit: 99999 });
    if (r.ok) expect(r.value.limit).toBe(1000);
  });
});

describe("planQuery — security perimeter", () => {
  it("rejects a filter on a non-filterable field", () => {
    const r = planQuery(config(), { filters: [{ field: "id", op: "eq", value: 1 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/not filterable/);
  });

  it("rejects an operator not allowed on a field", () => {
    const r = planQuery(config(), { filters: [{ field: "borough", op: "gt", value: "X" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/not allowed/);
  });

  it("rejects selecting a non-selectable column (no column leakage)", () => {
    const r = planQuery(config(), { select: ["secret"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/not selectable/);
  });

  it("rejects selecting a column that isn't in the schema", () => {
    const r = planQuery(config(), { select: ["ghost"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/not a schema field/);
  });

  it("rejects sorting by a non-sortable field", () => {
    const r = planQuery(config(), { sort: [{ field: "borough" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/not sortable/);
  });

  it("rejects an unknown top-level key (strict — no smuggling)", () => {
    const r = planQuery(config(), { rawSql: "DROP TABLE x" });
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong-typed filter value", () => {
    const r = planQuery(config(), { filters: [{ field: "borough", op: "eq", value: 42 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/wrong type/);
  });

  it("rejects 'in' without a non-empty array", () => {
    const r = planQuery(config(), { filters: [{ field: "borough", op: "in", value: "BRONX" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/non-empty array/);
  });

  it("collects multiple issues at once", () => {
    const r = planQuery(config(), {
      select: ["ghost"],
      filters: [{ field: "id", op: "eq", value: 1 }],
      sort: [{ field: "borough" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ── adversarial hardening (from the 3-way review) ────────────────────────────
/** Same Tap but with `selectable: "*"` — to prove `*` never reaches SQL as a raw star. */
function starConfig() {
  const r = parseConfig({
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
      { name: "secret", type: "string", required: false },
    ],
    query: {
      filters: [],
      selectable: "*",
      sortable: ["created"],
      maxLimit: 1000,
      defaultLimit: 100,
    },
    pricing: {
      unit: "row",
      unitDefinition: "one record",
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
  });
  if (!r.ok) throw new Error("fixture config invalid");
  return r.value;
}

describe("planQuery — hardening", () => {
  it("expands selectable '*' to the declared schema columns (never a raw '*')", () => {
    const r = planQuery(starConfig(), {});
    expect(r.ok).toBe(true);
    // '*' resolves to ALL declared fields — and only declared fields (no undeclared physical columns).
    if (r.ok) expect(r.value.columns).toEqual(["id", "borough", "created", "secret"]);
  });

  it("clamps a large offset to the pagination ceiling, and rejects an unsafe-integer offset", () => {
    const clamped = planQuery(config(), { offset: 1_000_000_000_000 }); // valid int, above the ceiling
    expect(clamped.ok).toBe(true);
    if (clamped.ok) expect(clamped.value.offset).toBe(100_000_000);
    // beyond Number.MAX_SAFE_INTEGER → rejected outright (no sci-notation SQL ever reaches DuckDB)
    expect(planQuery(config(), { offset: 1e21 }).ok).toBe(false);
  });

  it("rejects an 'in' list over the cap", () => {
    const big = Array.from({ length: 101 }, (_, i) => `B${i}`);
    const r = planQuery(config(), { filters: [{ field: "borough", op: "in", value: big }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/exceeds 100/);
  });

  it("rejects an unparseable timestamp value (would 500 in DuckDB otherwise)", () => {
    const r = planQuery(config(), {
      filters: [{ field: "created", op: "gte", value: "not-a-date" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/not a valid timestamp/);
  });

  it("rejects an over-long string value", () => {
    const r = planQuery(config(), {
      filters: [{ field: "borough", op: "eq", value: "x".repeat(513) }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/exceeds 512/);
  });

  it("rejects a request with too many filters (shape cap)", () => {
    const many = Array.from({ length: 33 }, () => ({ field: "borough", op: "eq", value: "X" }));
    const r = planQuery(config(), { filters: many });
    expect(r.ok).toBe(false);
  });
});
