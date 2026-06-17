/**
 * aqueduct-query — the paid-data tool an LLM agent invokes to buy specific rows from an Aqueduct Tap.
 *
 *   # free: discover the columns, filters, and price before paying
 *   npx tsx skills/aqueduct/query.ts <tapUrl> --schema
 *
 *   # paid: buy exactly the rows the query selects (per-row, over one MPP session, settled on close)
 *   AQUEDUCT_AGENT_KEY=0x<funded-key> \
 *     npx tsx skills/aqueduct/query.ts <tapUrl> '{"filters":[...],"sort":[...],"limit":5}'
 *
 * Prints JSON to stdout. The agent reads /schema first, forms a request inside the declared query
 * interface, then calls this — it never downloads the whole dataset, only the rows it asked for.
 */
import { tempo } from "mppx/client";
import { http, createClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { DEFAULT_RPC_URL } from "../../core/constants";

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

function fail(msg: string): never {
  console.error(`aqueduct-query: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [tapUrl, arg] = process.argv.slice(2);
  if (!tapUrl || !arg) fail("usage: query.ts <tapUrl> --schema | '<request-json>'");
  const base = tapUrl.replace(/\/$/, "");

  // Free discovery — terms before payment. No wallet needed.
  if (arg === "--schema") {
    const res = await fetch(`${base}/schema`);
    if (!res.ok) fail(`/schema returned ${res.status}`);
    console.log(JSON.stringify(await res.json(), null, 2));
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
  const account = privateKeyToAccount(key as `0x${string}`);

  // Re-wrap responses so the session manager can attach receipt/cumulative (and 204/304 carry no body).
  const extensibleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await fetch(input, init);
    const nullBody = r.status === 204 || r.status === 304;
    return new Response(nullBody ? null : await r.arrayBuffer(), {
      status: r.status,
      headers: r.headers,
    });
  }) as typeof fetch;

  const session = tempo.session.manager({
    account,
    getClient,
    maxDeposit: process.env.AQUEDUCT_MAX_DEPOSIT ?? "1",
    fetch: extensibleFetch,
  });

  const q = Buffer.from(JSON.stringify(request)).toString("base64url");
  const res = (await session.fetch(`${base}/query?q=${q}`, { method: "GET" })) as Response;
  if (res.status !== 200) fail(`query returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    rows: unknown[];
    count: number;
    amount: string;
    cached: boolean;
  };

  // One targeted query → settle the channel now (single on-chain tx). For many queries, keep the
  // session open in a longer-lived client; this tool is the simple one-shot the skill documents.
  const receipt = (await session.close()) as { reference?: string } | undefined;

  console.log(
    JSON.stringify({
      count: body.count,
      paid: `${body.amount} pathUSD`,
      cached: body.cached,
      settlement: receipt?.reference ?? null,
      rows: body.rows,
    }),
  );
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
