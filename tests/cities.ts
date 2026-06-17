/**
 * Shared test fixtures for the "cities" dataset.
 *
 * Several suites (evals, server, duckdb, onboard, defaults) exercise the same toy CSV + Tap shape.
 * Keeping the data, the temp-file dance, and the canonical config in one place stops them drifting
 * (they already had). Suites with a deliberately different shape (the nyc-311 planner/parser
 * fixtures) keep their own inline config on purpose — this is only the cities common ground.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "../core/config";
import { PATH_USD } from "../core/constants";
import type { OnboardInput } from "../core/onboard";

/** Four cities (id,name,pop,country). */
export const CITIES_CSV =
  "id,name,pop,country\n1,Tokyo,37000000,JP\n2,Delhi,29000000,IN\n3,Shanghai,26000000,CN\n4,Paris,11000000,FR\n";
/** Two cities — same columns, smaller body for count-sensitive suites. */
export const CITIES_CSV_2ROW = "id,name,pop,country\n1,Tokyo,37000000,JP\n2,Paris,11000000,FR\n";

/** Anvil account #0 — the canonical test payout address. */
export const RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const CURRENCY = PATH_USD;

/** Write `content` to a fresh temp dir; returns the csv path and a cleanup to call in `afterAll`. */
export function writeTempCsv(
  prefix: string,
  content: string,
): { dir: string; csv: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const csv = join(dir, "cities.csv");
  writeFileSync(csv, content);
  return { dir, csv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A CSV `Source` pointing at `ref`, with the standard deterministic contract. */
export function citiesSource(ref: string): Source {
  return {
    format: "csv",
    location: { via: "path", ref },
    authEnv: null,
    contract: { determinism: "deterministic", freshnessWindow: "24h" },
  };
}

/** An `OnboardInput` for the cities dataset at `ref`. */
export function citiesInput(ref: string): OnboardInput {
  return { name: "cities", source: citiesSource(ref), recipient: RECIPIENT, currency: CURRENCY };
}

/**
 * The canonical cities Tap config (raw object — caller parses/validates). Schema is name+pop; pass
 * `golden`/`invariants` to seed the eval section. Shared by the evals and server suites.
 */
export function citiesConfig(
  overrides: { golden?: unknown[]; invariants?: string[]; ref?: string } = {},
): unknown {
  return {
    version: 1,
    name: "cities",
    source: citiesSource(overrides.ref ?? "/tmp/x.csv"),
    schema: [
      { name: "name", type: "string", required: true },
      { name: "pop", type: "integer", required: true },
    ],
    query: {
      filters: [{ field: "pop", ops: ["gte"] }],
      selectable: ["name", "pop"],
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
    evals: {
      golden: overrides.golden ?? [],
      invariants: overrides.invariants ?? [],
      sampleSize: 5,
    },
    mpp: { intent: "session", recipient: RECIPIENT, currency: CURRENCY, feePayer: true },
  };
}
