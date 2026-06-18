/**
 * Streaming demo (manual, EXPERIMENTAL — not part of the test suite) — per-row streaming over MPP SSE.
 *
 * Shows the thing the Tempo team wanted to see: an agent opens ONE session, rows arrive over SSE, and
 * it's metered **per row as delivered**.
 *
 *   onboard'd Tap → GET /query/stream → 402 → session opens → rows stream in, one unitPrice each.
 *
 * STATUS: per-row delivery + metering work end-to-end; session-close voucher reconciliation has a
 * known open issue (see runtime/stream.ts). The demo reports that outcome instead of crashing.
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
import { DEFAULT_RPC_URL, PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";
import { validate } from "../core/evals";
import { createTapServer } from "../runtime/server";
import { mountStreamRoute } from "../runtime/stream";

// EXPERIMENTAL: the in-process SSE metering aborts the stream on the known close-accounting issue,
// which surfaces as an unhandled rejection from the SDK. Swallow that one signature so the demo's
// output stays clean; anything else still throws.
process.on("unhandledRejection", (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("reserved voucher coverage")) return;
  throw e;
});

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

// How many rows the agent will actually consume before walking away (the dataset has far more).
const CONSUME = 8;
const REQUEST_LIMIT = 100; // what we *ask* for — to prove we don't pay for the unconsumed tail

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

  // Load a Tap config (or onboard the bundled exoplanets file deterministically).
  const base = configPath
    ? parseConfig(JSON.parse(readFileSync(resolve(configPath), "utf8")))
    : await (async () => {
        const r = await deriveConfig(
          {
            name: "exoplanets",
            source: {
              format: "csv",
              location: { via: "path", ref: resolve("examples/exoplanets.csv") },
              authEnv: null,
              contract: { determinism: "deterministic", freshnessWindow: "24h" },
            },
            recipient: "0x0000000000000000000000000000000000000000",
            currency: PATH_USD,
          },
          { engine },
        );
        if (!r.ok) throw new Error("onboard failed");
        return parseConfig(r.value.config);
      })();
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
  mountStreamRoute(app, config, engine, opts); // ← the experimental SSE route

  const port = 8498;
  const server = serve({ fetch: app.fetch, port });
  const tap = `http://localhost:${port}`;
  console.log(`▸ Tap '${config.name}' streaming on ${tap}/query/stream\n`);

  const agentKey = generatePrivateKey();
  await fundAndWait(privateKeyToAccount(agentKey).address, "agent");

  // The closest Earth-sized planets — stream them, take a handful, leave the rest unpaid.
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
  console.log(
    `▸ agent asks for up to ${REQUEST_LIMIT} rows, will consume ${CONSUME}, then walk away`,
  );
  console.log(`  (${config.pricing.unitPrice} pathUSD per row, charged as each arrives)\n`);

  let consumed = 0;
  let closeNote = "(settled on close)";
  for await (const { row, index } of streamRows(tap, request, {
    key: agentKey,
    rpcUrl: RPC,
    onReceipt: (r) => {
      const ref = (r as { reference?: string })?.reference;
      if (ref) settlement = ref;
    },
    // EXPERIMENTAL: multi-tick voucher reconciliation at close has an open accounting issue in the
    // MPP SSE layer — surface it instead of crashing; the streamed rows above are real.
    onClose: (err, receipt) => {
      closeNote = err
        ? `⚠ close unsettled (experimental): ${err.message.split("[")[0].trim()}`
        : `settled: ${(receipt as { reference?: string })?.reference ?? "ok"}`;
    },
  })) {
    consumed = index;
    const runningCost = (index * unit).toFixed(4);
    console.log(
      `  row ${String(index).padStart(2)}  ${String(row.name).padEnd(16)} ` +
        `${String(row.distance_pc).padStart(7)} pc   paid so far: ${runningCost} pathUSD`,
    );
    if (index >= CONSUME) {
      console.log(`\n▸ agent has what it needs — disconnecting after ${CONSUME} rows`);
      break; // the generator's finally{} closes + settles the session
    }
  }

  console.log("\n── result ──");
  console.log(`  requested up to : ${REQUEST_LIMIT} rows`);
  console.log(
    `  consumed        : ${consumed} rows  (${(consumed * unit).toFixed(4)} pathUSD metered)`,
  );
  console.log(`  unpaid tail     : ${REQUEST_LIMIT - consumed} rows never delivered`);
  console.log(`  per-row receipt : ${settlement ?? "(streamed)"}`);
  console.log(`  channel close   : ${closeNote}`);
  console.log("\n  ↑ EXPERIMENTAL. Per-row SSE delivery + metering work; session-close voucher");
  console.log("    reconciliation has a known open issue (see runtime/stream.ts).");

  server.close();
  engine.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
