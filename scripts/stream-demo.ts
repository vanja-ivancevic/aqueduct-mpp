/**
 * Streaming demo (manual — not part of the test suite) — per-row streaming over MPP SSE.
 *
 * The thing the Tempo team wanted to see: an agent opens ONE session, rows arrive over SSE, each
 * metered **as it's delivered**, and the channel settles on-chain at close.
 *
 *   onboard'd Tap → GET /query/stream → 402 → session opens → rows stream in (one unitPrice each)
 *   → stream ends → channel close settles the cumulative voucher on Tempo.
 *
 * Works end-to-end on Moderato (requires two mppx SSE-metering fixes shipped as patches/mppx+*.patch).
 * Known edge: an agent that disconnects *mid-stream* leaves the close voucher one row short — consume
 * the full stream for a clean settle. The client surfaces any close error via onClose, never crashes.
 *
 * Run:  npx tsx scripts/stream-demo.ts [config.tap.json]   (default: examples/exoplanets via onboard)
 * Needs network + the public faucet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { streamRows } from "../adapters/client/client";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { parseConfig } from "../core/config";
import { DEFAULT_RPC_URL, EXPLORER_URL, PATH_USD } from "../core/constants";
import { validate } from "../core/evals";
import { createTapServer } from "../runtime/server";
import { mountStreamRoute } from "../runtime/stream";

// Safety net: if a mid-stream disconnect ever leaves the SDK metering in the aborted-stream state, it
// surfaces as an unhandled rejection. Swallow that one signature so the demo's output stays clean;
// anything else still throws. (Consuming the full stream — as below — settles cleanly and never hits it.)
process.on("unhandledRejection", (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("reserved voucher coverage")) return;
  throw e;
});

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

// Stream the N closest Earth-sized planets, metered per row, settle on close.
const REQUEST_LIMIT = 15;

async function fundAndWait(address: `0x${string}`, label: string): Promise<void> {
  console.log(`▸ funding ${label} ${address} …`);
  await Actions.faucet.fund(getClient(), { account: address });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const bal = await Actions.token.getBalance(getClient(), {
        account: address,
        token: PATH_USD,
      });
      if (bal > 0n) {
        console.log(`  ✓ ${label} funded`);
        return;
      }
    } catch {
      /* account uninitialized until first credit */
    }
  }
  throw new Error(`timed out funding ${label}`);
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  const engine = await DuckDbEngine.create();

  // Load a Tap config — defaults to the committed exoplanets Tap, which sources the LIVE NASA archive
  // (auto-refreshing per its freshnessWindow), so the stream serves fresh data, not a stale snapshot.
  const base = parseConfig(
    JSON.parse(readFileSync(resolve(configPath ?? "examples/exoplanets.tap.json"), "utf8")),
  );
  if (!base.ok) throw new Error(`config invalid: ${JSON.stringify(base.error.issues)}`);

  const gate = await validate(base.value, engine);
  if (!gate.ok) throw new Error("config fails evals");

  // Server wallet receives settlement; agent self-pays gas (feePayer off — the clean Moderato path).
  const serverAccount = privateKeyToAccount(
    (process.env.AQUEDUCT_PRIVATE_KEY ?? generatePrivateKey()) as `0x${string}`,
  );
  const config = {
    ...gate.config,
    mpp: { ...gate.config.mpp, recipient: serverAccount.address, feePayer: false },
  } as typeof gate.config;

  await fundAndWait(serverAccount.address, "server");

  const opts = { account: serverAccount, rpcUrl: RPC };
  const app = createTapServer(config, engine, opts);
  mountStreamRoute(app, config, engine, opts); // ← the opt-in SSE route

  const port = 8498;
  const server = serve({ fetch: app.fetch, port });
  const tap = `http://localhost:${port}`;
  console.log(`▸ Tap '${config.name}' streaming on ${tap}/query/stream\n`);

  const agentKey = generatePrivateKey();
  await fundAndWait(privateKeyToAccount(agentKey).address, "agent");

  // The closest Earth-sized planets — stream them all, metered per row over one session.
  const request = {
    select: ["name", "distance_pc", "radius_earth"],
    filters: [
      { field: "radius_earth", op: "gte", value: 0.8 },
      { field: "radius_earth", op: "lte", value: 1.5 },
    ],
    sort: [{ field: "distance_pc", dir: "asc" }],
    limit: REQUEST_LIMIT,
  };

  const unit = Number(config.pricing.unitPrice);
  let settlement: string | null = null;
  let closeError: string | null = null;
  console.log(
    `▸ agent streams the ${REQUEST_LIMIT} closest Earth-sized planets over one MPP session`,
  );
  console.log(`  (${config.pricing.unitPrice} pathUSD per row, metered as each arrives)\n`);

  let consumed = 0;
  for await (const { row, index } of streamRows(tap, request, {
    key: agentKey,
    rpcUrl: RPC,
    onClose: (err, receipt) => {
      if (err) closeError = err.message.split("[")[0].trim();
      else settlement = (receipt as { reference?: string })?.reference ?? "ok";
    },
  })) {
    consumed = index;
    const runningCost = (index * unit).toFixed(4);
    console.log(
      `  row ${String(index).padStart(2)}  ${String(row.name).padEnd(16)} ` +
        `${String(row.distance_pc).padStart(7)} pc   metered so far: ${runningCost} pathUSD`,
    );
  }

  console.log("\n── result ──");
  console.log(`  streamed + metered : ${consumed} rows  (${(consumed * unit).toFixed(4)} pathUSD)`);
  console.log(`  channel close      : ${closeError ? `⚠ ${closeError}` : "settled on-chain"}`);
  if (settlement) console.log(`  settlement tx      : ${EXPLORER_URL}/tx/${settlement}`);
  console.log(
    "\n  ↑ one MPP session, metered per row over SSE, settled on-chain. That's streaming.",
  );

  server.close();
  engine.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
