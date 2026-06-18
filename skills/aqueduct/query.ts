/**
 * aqueduct-query — the tool an LLM agent invokes to find, inspect, and buy rows from an Aqueduct Tap.
 * A thin CLI over the shared consumption client (`adapters/client`) — same three ops the MCP server
 * exposes, so the skill and MCP never drift.
 *
 *   # find Taps in MPP's registry (free; no wallet)
 *   npx tsx skills/aqueduct/query.ts --discover [query]
 *
 *   # read a Tap's terms — columns, filters, price (free; no wallet)
 *   npx tsx skills/aqueduct/query.ts <tapUrl> --schema
 *
 *   # buy exactly the rows the query selects (per-row, over one MPP session, settled on close)
 *   AQUEDUCT_AGENT_KEY=0x<funded-key> \
 *     npx tsx skills/aqueduct/query.ts <tapUrl> '{"filters":[...],"sort":[...],"limit":5}'
 *
 * Prints JSON to stdout.
 */
import { buyRows, discover, fetchSchema } from "../../adapters/client/client";

function fail(msg: string): never {
  console.error(`aqueduct-query: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [first, second] = process.argv.slice(2);
  if (!first)
    fail("usage: query.ts --discover [q] | <tapUrl> --schema | <tapUrl> '<request-json>'");

  // Discovery — read MPP's public registry, no wallet, no payment.
  if (first === "--discover") {
    console.log(JSON.stringify(await discover(second), null, 2));
    return;
  }

  const tapUrl = first;
  const arg = second;
  if (!arg) fail("usage: query.ts <tapUrl> --schema | '<request-json>'");

  // Free discovery — terms before payment. No wallet needed.
  if (arg === "--schema") {
    console.log(JSON.stringify(await fetchSchema(tapUrl), null, 2));
    return;
  }

  // Paid query. Validate the request is JSON locally before spending anything.
  let request: unknown;
  try {
    request = JSON.parse(arg);
  } catch {
    fail("request must be --schema or a JSON object");
  }
  const key = process.env.AQUEDUCT_AGENT_KEY;
  if (!key?.startsWith("0x")) fail("set AQUEDUCT_AGENT_KEY to a 0x-prefixed funded agent key");

  const result = await buyRows(tapUrl, request, {
    key,
    rpcUrl: process.env.AQUEDUCT_RPC_URL,
    maxDeposit: process.env.AQUEDUCT_MAX_DEPOSIT,
  });

  console.log(
    JSON.stringify({
      count: result.count,
      paid: `${result.amount} pathUSD`,
      cached: result.cached,
      settlement: result.settlement,
      rows: result.rows,
    }),
  );
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
