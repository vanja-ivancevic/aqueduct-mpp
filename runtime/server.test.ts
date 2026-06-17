import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { type ValidatedConfig, parseConfig } from "../core/config";
import { validate } from "../core/evals";
import { CITIES_CSV_2ROW, citiesConfig, writeTempCsv } from "../tests/cities";
import type { Row, RowCache } from "./cache";
import { createTapServer } from "./server";

const q = (req: unknown) => Buffer.from(JSON.stringify(req)).toString("base64url");

// A throwaway dev account — no funds; only used to construct the server (free routes don't pay).
const account = privateKeyToAccount(`0x${"1".repeat(64)}`);

let cleanup: () => void;
let engine: DuckDbEngine;
let config: ValidatedConfig;

beforeAll(async () => {
  const tmp = writeTempCsv("aqueduct-srv-", CITIES_CSV_2ROW);
  cleanup = tmp.cleanup;
  engine = await DuckDbEngine.create();
  const r = parseConfig(citiesConfig({ ref: tmp.csv }));
  if (!r.ok) throw new Error("fixture config invalid");
  const gate = await validate(r.value, engine);
  if (!gate.ok) throw new Error("fixture config failed evals");
  config = gate.config;
});
afterAll(() => cleanup());

describe("createTapServer", () => {
  it("constructs and serves free discovery at /schema (no payment, no network)", async () => {
    const app = createTapServer(config, engine, { account });
    const res = await app.request("/schema");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; pricing: { unitPrice: string } };
    expect(body.name).toBe("cities");
    expect(body.pricing.unitPrice).toBe("0.0001");
  });

  it("rejects a malformed query (undeclared filter) with 400 before any charge", async () => {
    const app = createTapServer(config, engine, { account });
    // name is not a declared filter field; content path is GET /query?q=<base64url JSON>
    const q = Buffer.from(
      JSON.stringify({ filters: [{ field: "name", op: "eq", value: "X" }] }),
    ).toString("base64url");
    const res = await app.request(`/query?q=${q}`);
    expect(res.status).toBe(400);
  });

  it("rejects an over-large q before decoding (DoS guard)", async () => {
    const app = createTapServer(config, engine, { account });
    const res = await app.request(`/query?q=${"A".repeat(300_000)}`);
    expect(res.status).toBe(400);
  });

  it("rejects a q that isn't base64url JSON", async () => {
    const app = createTapServer(config, engine, { account });
    const res = await app.request("/query?q=@@@not-base64@@@");
    expect(res.status).toBe(400);
  });

  // ── billing accounting (no network: these branches resolve before the on-chain charge) ──

  it("serves a zero-row query free (no charge) and reports amount 0", async () => {
    const app = createTapServer(config, engine, { account });
    // pop >= a value above every row → 0 matches → the free branch returns before charging
    const res = await app.request(
      `/query?q=${q({ filters: [{ field: "pop", op: "gte", value: 9e9 }] })}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; count: number; amount: string };
    expect(body.count).toBe(0);
    expect(body.rows).toEqual([]);
    expect(body.amount).toBe("0");
  });

  it("caches the empty result so a repeated zero-row query reports cached:true", async () => {
    const app = createTapServer(config, engine, { account });
    const url = `/query?q=${q({ filters: [{ field: "pop", op: "gte", value: 9e9 }] })}`;
    const first = (await (await app.request(url)).json()) as { cached: boolean };
    expect(first.cached).toBe(false);
    const second = (await (await app.request(url)).json()) as { cached: boolean };
    expect(second.cached).toBe(true);
  });

  it("gates a row-returning query behind payment (402) — never serves rows unpaid", async () => {
    const app = createTapServer(config, engine, { account });
    // 2 rows match; with no payment credential the session gate must respond 402, not 200 with rows
    const res = await app.request(
      `/query?q=${q({ filters: [{ field: "pop", op: "gte", value: 0 }] })}`,
    );
    expect(res.status).toBe(402);
  });

  it("requires payment even on a cache HIT — cached rows are not free", async () => {
    // Inject a cache that always hits with one row. The hit path skips DuckDB but must still charge:
    // returned = cached.length = 1 → priced → 402 until paid. (Security: caching ≠ bypassing payment.)
    const cache: RowCache = {
      get: (): Row[] => [{ name: "Tokyo", pop: 37000000 }],
      set: () => {},
    };
    const app = createTapServer(config, engine, { account, cache });
    const res = await app.request(
      `/query?q=${q({ filters: [{ field: "pop", op: "gte", value: 0 }] })}`,
    );
    expect(res.status).toBe(402);
  });
});
