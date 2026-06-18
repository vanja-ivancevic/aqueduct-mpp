/**
 * Benchmark query tool — the Arm-B analog of "the agent has an Aqueduct Tap".
 *
 * An agent calls this with a Tap config and a constrained request (the same {select,filters,sort,limit}
 * contract the real Tap enforces). It plans the query through core/query (no raw SQL — the security
 * perimeter) and executes it via DuckDB, printing the rows + the metered data cost. No payment here:
 * the benchmark isolates the *token* cost of using a structured interface vs writing code; the
 * data-plane price (rows x unitPrice) is reported and summed analytically.
 *
 *   npx tsx scripts/bench-query.ts <tap.json> '<request-json>'
 *   npx tsx scripts/bench-query.ts <tap.json> --schema
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { parseConfig } from "../core/config";
import { unitsCost } from "../core/pricing";
import { planQuery, queryPolicy } from "../core/query";

async function main(): Promise<void> {
  const [file, arg] = process.argv.slice(2);
  if (!file || !arg) {
    console.error("usage: bench-query.ts <tap.json> --schema | '<request-json>'");
    process.exit(1);
  }
  const parsed = parseConfig(JSON.parse(readFileSync(resolve(file), "utf8")));
  if (!parsed.ok) {
    console.error("invalid tap config");
    process.exit(1);
  }
  const config = parsed.value;

  if (arg === "--schema") {
    console.log(
      JSON.stringify(
        { name: config.name, schema: config.schema, query: config.query, pricing: config.pricing },
        null,
        2,
      ),
    );
    return;
  }

  let request: unknown;
  try {
    request = JSON.parse(arg);
  } catch {
    console.error("request must be --schema or a JSON object");
    process.exit(1);
  }

  const planned = planQuery(config, request, queryPolicy(config));
  if (!planned.ok) {
    console.error(`rejected by query interface: ${JSON.stringify(planned.error.issues)}`);
    process.exit(1);
  }

  const engine = await DuckDbEngine.create();
  const rows = await engine.query(config, planned.value);
  engine.close();

  const cost = unitsCost(config.pricing.unitPrice, rows.length);
  console.log(JSON.stringify({ count: rows.length, dataCostPathUSD: cost, rows }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
