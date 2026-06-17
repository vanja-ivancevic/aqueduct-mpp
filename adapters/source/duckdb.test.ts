import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TapConfig, parseConfig } from "../../core/config";
import { planQuery } from "../../core/query";
import { CITIES_CSV, CURRENCY, RECIPIENT, citiesSource, writeTempCsv } from "../../tests/cities";
import { DuckDbEngine, compilePlan } from "./duckdb";

let csv: string;
let cleanup: () => void;

beforeAll(() => {
  const tmp = writeTempCsv("aqueduct-", CITIES_CSV);
  csv = tmp.csv;
  cleanup = tmp.cleanup;
});
afterAll(() => cleanup());

// A richer config than the shared cities fixture: all four columns selectable/filterable, incl. a
// `like` filter on name — this suite exercises SQL compilation, so it declares the full surface.
function config(ref: string): TapConfig {
  const r = parseConfig({
    version: 1,
    name: "cities",
    source: citiesSource(ref),
    schema: [
      { name: "id", type: "integer", required: true },
      { name: "name", type: "string", required: true },
      { name: "pop", type: "integer", required: true },
      { name: "country", type: "string", required: true },
    ],
    query: {
      filters: [
        { field: "country", ops: ["eq", "in"] },
        { field: "pop", ops: ["gte", "lte"] },
        { field: "name", ops: ["like", "eq"] },
      ],
      selectable: ["id", "name", "pop", "country"],
      sortable: ["pop"],
      maxLimit: 100,
      defaultLimit: 10,
    },
    pricing: {
      unit: "row",
      unitDefinition: "one city",
      unitPrice: "0.0001",
      currency: CURRENCY,
    },
    cache: { key: "queryHash", ttl: "1h" },
    evals: { golden: [], invariants: [], sampleSize: 5 },
    mpp: { intent: "session", recipient: RECIPIENT, currency: CURRENCY, feePayer: true },
  });
  if (!r.ok) throw new Error("fixture config invalid");
  return r.value;
}

function plan(config: TapConfig, req: unknown) {
  const r = planQuery(config, req);
  if (!r.ok) throw new Error(`plan failed: ${JSON.stringify(r.error.issues)}`);
  return r.value;
}

describe("compilePlan", () => {
  it("emits parameterized SQL with values bound (never inlined)", () => {
    const c = config(csv);
    const { sql, params } = compilePlan(
      c,
      plan(c, { filters: [{ field: "country", op: "eq", value: "JP" }] }),
    );
    expect(sql).toMatch(/WHERE "country" = \?/);
    expect(sql).toMatch(/read_csv_auto\('/);
    expect(params).toEqual(["JP"]);
  });

  it("expands an IN filter to one placeholder per value", () => {
    const c = config(csv);
    const { sql, params } = compilePlan(
      c,
      plan(c, { filters: [{ field: "country", op: "in", value: ["JP", "FR"] }] }),
    );
    expect(sql).toMatch(/"country" IN \(\?, \?\)/);
    expect(params).toEqual(["JP", "FR"]);
  });
});

describe("DuckDbEngine — end to end on a real CSV", () => {
  let engine: DuckDbEngine;
  beforeAll(async () => {
    engine = await DuckDbEngine.create();
  });

  it("types a nested struct column as json, not by an inner scalar name", async () => {
    // Regression: a `STRUCT(w BIGINT, …)` signature contains "BIGINT" — the scalar check must not
    // mis-type it as integer. Compound types resolve to `json` (selectable, not filter/sortable).
    const tmp = writeTempCsv("aqueduct-struct-", '{"id":1,"payload":{"w":5,"kind":"a"}}\n');
    const src = citiesSource(tmp.csv);
    src.format = "json";
    try {
      const schema = await engine.describe(src);
      expect(schema.find((f) => f.name === "payload")?.type).toBe("json");
      expect(schema.find((f) => f.name === "id")?.type).toBe("integer");
    } finally {
      tmp.cleanup();
    }
  });

  it("filters, sorts, selects, limits → real rows", async () => {
    const c = config(csv);
    const rows = await engine.query(
      c,
      plan(c, {
        select: ["name", "pop"],
        filters: [{ field: "pop", op: "gte", value: 20000000 }],
        sort: [{ field: "pop", dir: "desc" }],
        limit: 2,
      }),
    );
    expect(rows).toEqual([
      { name: "Tokyo", pop: 37000000 },
      { name: "Delhi", pop: 29000000 },
    ]);
  });

  it("applies an IN filter", async () => {
    const c = config(csv);
    const rows = await engine.query(
      c,
      plan(c, {
        select: ["name"],
        filters: [{ field: "country", op: "in", value: ["JP", "FR"] }],
        sort: [{ field: "pop", dir: "desc" }],
      }),
    );
    expect(rows).toEqual([{ name: "Tokyo" }, { name: "Paris" }]);
  });

  it("applies a LIKE filter with wildcard semantics (% binds as a param, not inlined SQL)", async () => {
    const c = config(csv);
    const { sql, params } = compilePlan(
      c,
      plan(c, { filters: [{ field: "name", op: "like", value: "Sha%" }] }),
    );
    expect(sql).toMatch(/"name" LIKE \?/); // operator compiled, value parameterized
    expect(params).toEqual(["Sha%"]);
    const rows = await engine.query(
      c,
      plan(c, { select: ["name"], filters: [{ field: "name", op: "like", value: "Sha%" }] }),
    );
    expect(rows).toEqual([{ name: "Shanghai" }]);
  });

  it("empty request → default columns, default limit", async () => {
    const c = config(csv);
    const rows = await engine.query(c, plan(c, {}));
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0] ?? {})).toEqual(["id", "name", "pop", "country"]);
  });

  it("totalRows + violations back the coverage/invariant evals", async () => {
    const c = config(csv);
    expect(await engine.totalRows(c)).toBe(4);
    expect(await engine.violations(c, "pop > 0")).toBe(0); // none violate
    expect(await engine.violations(c, "pop < 0")).toBe(4); // all violate
  });

  it("countMatching returns the billable (returned) row count", async () => {
    const c = config(csv);
    // 3 cities have pop >= 20M (Tokyo, Delhi, Shanghai)
    expect(
      await engine.countMatching(
        c,
        plan(c, { filters: [{ field: "pop", op: "gte", value: 20000000 }] }),
      ),
    ).toBe(3);
    // clamped by limit
    expect(
      await engine.countMatching(
        c,
        plan(c, { filters: [{ field: "pop", op: "gte", value: 20000000 }], limit: 2 }),
      ),
    ).toBe(2);
    // clamped by offset
    expect(await engine.countMatching(c, plan(c, { limit: 100, offset: 3 }))).toBe(1); // 4 total - offset 3
  });
});
