import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDbEngine } from "../adapters/source/duckdb";
import {
  CITIES_CSV,
  citiesInput as input,
  citiesSource as source,
  writeTempCsv,
} from "../tests/cities";
import { type LlmProvider, extractJson, onboard } from "./onboard";
import { ok } from "./result";

let csv: string;
let cleanup: () => void;
let engine: DuckDbEngine;

beforeAll(async () => {
  const tmp = writeTempCsv("aqueduct-onboard-", CITIES_CSV);
  csv = tmp.csv;
  cleanup = tmp.cleanup;
  engine = await DuckDbEngine.create();
});
afterAll(() => cleanup());

/** An LLM stand-in that returns a fixed Decisions JSON, optionally wrapped in prose/fences. */
function fakeLlm(reply: string): LlmProvider {
  return { complete: async () => ok(reply) };
}

const GOOD_DECISIONS = JSON.stringify({
  query: {
    filters: [
      { field: "country", ops: ["eq", "in"] },
      { field: "pop", ops: ["gte", "lte"] },
    ],
    selectable: ["id", "name", "pop", "country"],
    sortable: ["pop"],
    maxLimit: 100,
    defaultLimit: 10,
  },
  unitDefinition: "one city row",
  golden: [
    { request: { filters: [{ field: "pop", op: "gte", value: 20000000 }] }, expectRowCount: 3 },
  ],
  invariants: ["pop >= 0"],
});

describe("DuckDbEngine onboarding profilers", () => {
  it("describe() infers columns and types from the file", async () => {
    const schema = await engine.describe(source(csv));
    expect(schema).toEqual([
      { name: "id", type: "integer", required: false },
      { name: "name", type: "string", required: false },
      { name: "pop", type: "integer", required: false },
      { name: "country", type: "string", required: false },
    ]);
  });

  it("sampleRaw() returns up to n rows", async () => {
    const rows = await engine.sampleRaw(source(csv), 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("Tokyo");
  });
});

describe("onboard pipeline", () => {
  it("profiles, takes LLM decisions, and returns an eval-passed config", async () => {
    const r = await onboard(input(csv), { engine, llm: fakeLlm(GOOD_DECISIONS) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.name).toBe("cities");
    expect(r.value.config.schema.map((f) => f.name)).toEqual(["id", "name", "pop", "country"]);
    expect(r.value.config.query.maxLimit).toBe(100);
    expect(r.value.report.passed).toBe(true);
    expect(r.value.attempts).toBe(1);
  });

  it("tolerates code-fenced / prose-wrapped JSON", async () => {
    const wrapped = `Here is the config:\n\`\`\`json\n${GOOD_DECISIONS}\n\`\`\`\nDone.`;
    const r = await onboard(input(csv), { engine, llm: fakeLlm(wrapped) });
    expect(r.ok).toBe(true);
  });

  it("retries with feedback when the first decisions reference an unknown field", async () => {
    const bad = JSON.stringify({
      query: {
        filters: [{ field: "ghost", ops: ["eq"] }],
        selectable: "*",
        sortable: [],
        maxLimit: 50,
        defaultLimit: 10,
      },
      unitDefinition: "row",
    });
    let call = 0;
    const llm: LlmProvider = {
      complete: async () => {
        call += 1;
        return ok(call === 1 ? bad : GOOD_DECISIONS);
      },
    };
    const r = await onboard(input(csv), { engine, llm });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attempts).toBe(2);
  });

  it("fails closed when evals can't pass (golden row-count wrong every time)", async () => {
    const wrongGolden = JSON.stringify({
      query: {
        filters: [{ field: "pop", ops: ["gte"] }],
        selectable: "*",
        sortable: ["pop"],
        maxLimit: 100,
        defaultLimit: 10,
      },
      unitDefinition: "row",
      golden: [
        { request: { filters: [{ field: "pop", op: "gte", value: 0 }] }, expectRowCount: 999 },
      ],
    });
    const r = await onboard(input(csv), { engine, llm: fakeLlm(wrongGolden) }, { maxAttempts: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe("evals");
  });
});

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced JSON with prose", () => {
    expect(extractJson('text\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
  });
  it("returns undefined for non-JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
  });
});
