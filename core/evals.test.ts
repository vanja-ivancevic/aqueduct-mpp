import { describe, expect, it } from "vitest";
import { citiesConfig } from "../tests/cities";
import { type TapConfig, parseConfig } from "./config";
import { type EvalEngine, runEvals, validate } from "./evals";
import type { QueryPlan } from "./query";

function config(overrides: { golden?: unknown[]; invariants?: string[] } = {}): TapConfig {
  const r = parseConfig(citiesConfig(overrides));
  if (!r.ok) throw new Error("fixture config invalid");
  return r.value;
}

/** Deterministic in-memory engine — no I/O. Lets us test eval orchestration purely. */
function fakeEngine(opts: {
  rows?: Record<string, unknown>[];
  total?: number;
  violations?: number;
}): EvalEngine {
  const rows = opts.rows ?? [
    { name: "Tokyo", pop: 37000000 },
    { name: "Delhi", pop: 29000000 },
  ];
  return {
    async query(_c: TapConfig, _p: QueryPlan) {
      return rows;
    },
    async totalRows() {
      return opts.total ?? rows.length;
    },
    async violations() {
      return opts.violations ?? 0;
    },
  };
}

describe("runEvals", () => {
  it("passes a healthy Tap (coverage + schema)", async () => {
    const r = await runEvals(config(), fakeEngine({}));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.results.map((x) => x.name)).toEqual(["coverage", "schema"]);
  });

  it("fails coverage when the source is empty", async () => {
    const r = await runEvals(config(), fakeEngine({ rows: [], total: 0 }));
    expect(r.passed).toBe(false);
    expect(r.results.find((x) => x.name === "coverage")?.passed).toBe(false);
  });

  it("fails schema when a required field is the wrong type", async () => {
    const r = await runEvals(config(), fakeEngine({ rows: [{ name: "X", pop: true }] }));
    expect(r.passed).toBe(false);
    expect(r.results.find((x) => x.name === "schema")?.passed).toBe(false);
  });

  it("passes a golden whose row-count matches", async () => {
    const c = config({
      golden: [
        { request: { filters: [{ field: "pop", op: "gte", value: 1 }] }, expectRowCount: 2 },
      ],
    });
    const r = await runEvals(c, fakeEngine({}));
    expect(r.passed).toBe(true);
    expect(r.results.some((x) => x.name === "golden[0]" && x.passed)).toBe(true);
  });

  it("fails a golden whose row-count drifts", async () => {
    const c = config({ golden: [{ request: {}, expectRowCount: 99 }] });
    const r = await runEvals(c, fakeEngine({}));
    expect(r.results.find((x) => x.name === "golden[0]")?.passed).toBe(false);
  });

  it("fails a golden with an invalid (disallowed) request", async () => {
    const c = config({
      golden: [
        { request: { filters: [{ field: "name", op: "eq", value: "X" }] }, expectRowCount: 0 },
      ],
    });
    const r = await runEvals(c, fakeEngine({}));
    expect(r.results.find((x) => x.name === "golden[0]")?.detail).toMatch(/invalid request/);
  });

  it("fails an invariant with violations", async () => {
    const c = config({ invariants: ["pop > 0"] });
    const r = await runEvals(c, fakeEngine({ violations: 3 }));
    expect(r.passed).toBe(false);
    expect(r.results.find((x) => x.name === "invariant")?.detail).toMatch(/3 rows violate/);
  });
});

describe("validate", () => {
  it("brands the config only when evals pass", async () => {
    const pass = await validate(config(), fakeEngine({}));
    expect(pass.ok).toBe(true);

    const fail = await validate(config(), fakeEngine({ total: 0, rows: [] }));
    expect(fail.ok).toBe(false);
  });
});
