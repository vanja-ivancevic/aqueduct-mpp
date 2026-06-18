import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { CITIES_CSV_2ROW, citiesInput, writeTempCsv } from "../tests/cities";
import type { FieldSpec } from "./config";
import { deriveConfig, deriveDecisions } from "./defaults";

describe("deriveDecisions (pure, no LLM)", () => {
  const schema: FieldSpec[] = [
    { name: "id", type: "integer", required: true },
    { name: "name", type: "string", required: true },
    { name: "active", type: "boolean", required: false },
    { name: "created", type: "timestamp", required: false },
    { name: "meta", type: "json", required: false },
  ];

  it("assigns type-appropriate operators and excludes json from filters/sort", () => {
    const d = deriveDecisions("things", schema);
    const byField = Object.fromEntries(d.query.filters.map((f) => [f.field, f.ops]));
    expect(byField.id).toEqual(["eq", "ne", "lt", "lte", "gt", "gte", "in"]);
    expect(byField.name).toEqual(["eq", "ne", "in", "like"]);
    expect(byField.active).toEqual(["eq", "ne"]);
    expect(byField.created).toEqual(["eq", "ne", "lt", "lte", "gt", "gte"]);
    expect(byField.meta).toBeUndefined(); // json not filterable
    expect(d.query.sortable).toEqual(["id", "name", "active", "created"]); // no json
    expect(d.query.selectable).toBe("*");
  });

  it("emits NOT NULL invariants only for required columns", () => {
    const d = deriveDecisions("things", schema);
    expect(d.invariants).toEqual(['"id" IS NOT NULL', '"name" IS NOT NULL']);
  });
});

describe("deriveConfig end-to-end on a real CSV (no LLM)", () => {
  let csv: string;
  let cleanup: () => void;
  let engine: DuckDbEngine;

  beforeAll(async () => {
    const tmp = writeTempCsv("aqueduct-defaults-", CITIES_CSV_2ROW);
    csv = tmp.csv;
    cleanup = tmp.cleanup;
    engine = await DuckDbEngine.create();
  });
  afterAll(() => cleanup());

  const input = () => citiesInput(csv);

  it("produces an eval-passed config with zero LLM calls", async () => {
    const r = await deriveConfig(input(), { engine });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.passed).toBe(true);
    expect(r.value.config.schema.map((f) => f.name)).toEqual(["id", "name", "pop", "country"]);
    expect(r.value.config.query.filters.map((f) => f.field)).toEqual([
      "id",
      "name",
      "pop",
      "country",
    ]);
    expect(r.value.config.pricing.unitDefinition).toBe("one row of cities");
    expect(r.value.attempts).toBe(1);
  });

  it("clamps cache.ttl down to a sub-default freshness window (keeps the config valid)", async () => {
    const i = input();
    const tight = {
      ...i,
      source: { ...i.source, contract: { ...i.source.contract, freshnessWindow: "5m" } },
    };
    const r = await deriveConfig(tight, { engine });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.cache.ttl).toBe("5m"); // default "1h" clamped to the 5m window
  });

  it("leaves cache.ttl at the default when the freshness window is larger", async () => {
    const r = await deriveConfig(input(), { engine }); // freshnessWindow "24h"
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.cache.ttl).toBe("1h");
  });
});
