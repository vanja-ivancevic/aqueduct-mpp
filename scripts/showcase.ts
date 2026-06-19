/**
 * Showcase — the honest pitch, end to end: "Stripe for data → agents."
 *
 * Not "Claude can't fetch a CSV" (it can). The point is the DX + the STANDARD:
 *   1. PUBLISH — any dataset becomes an agent-payable, discoverable Tap with one command ($0 LLM).
 *   2. CONSUME — ONE uniform client/skill buys from ANY Tap, regardless of domain or format.
 *   3. SETTLE  — every purchase is a real MPP micropayment on Tempo. No API keys, no contracts.
 *
 * Here a single "agent" answers a cross-domain question by buying exactly the rows it needs from THREE
 * heterogeneous Taps (space science · geophysics · forex) through the same interface — zero bespoke
 * integration per source. That uniformity is the product; DuckDB + MPP are just the engine.
 *
 *   AQUEDUCT_SERVER_KEY=0x… AQUEDUCT_AGENT_KEY=0x…  npx tsx scripts/showcase.ts
 *   (keys optional — faucet-funded if absent.) Needs network + the public faucet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { buyRows } from "../adapters/client/client";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { type ValidatedConfig, parseConfig } from "../core/config";
import { DEFAULT_RPC_URL, EXPLORER_URL, PATH_USD } from "../core/constants";
import { createTapServer } from "../runtime/server";

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const rule = (s: string) => console.log(`\n${bold(cyan(s))}\n${dim("─".repeat(74))}`);

async function fund(address: `0x${string}`, label: string): Promise<void> {
  try {
    if ((await Actions.token.getBalance(getClient(), { account: address, token: PATH_USD })) > 0n) {
      console.log(`  ${green("✓")} ${label} ${dim("(pre-funded)")}`);
      return;
    }
  } catch {
    /* uninitialized until first credit */
  }
  await Actions.faucet.fund(getClient(), { account: address });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if (
        (await Actions.token.getBalance(getClient(), { account: address, token: PATH_USD })) > 0n
      ) {
        console.log(`  ${green("✓")} ${label} ${dim("(faucet-funded)")}`);
        return;
      }
    } catch {
      /* still uninitialized */
    }
  }
  throw new Error(`faucet timeout for ${label}`);
}

// Three heterogeneous Taps + the one cross-domain question an agent answers from them.
const TAPS = [
  {
    file: "examples/exoplanets.tap.json",
    port: 8801,
    domain: "space science",
    onboard: "npx aqueduct onboard 'https://exoplanetarchive…/TAP/sync?query=…'",
    ask: "closest Earth-sized exoplanet",
    request: {
      select: ["name", "distance_pc"],
      filters: [
        { field: "radius_earth", op: "gte", value: 0.8 },
        { field: "radius_earth", op: "lte", value: 1.5 },
      ],
      sort: [{ field: "distance_pc", dir: "asc" }],
      limit: 1,
    },
  },
  {
    file: "examples/usgs-earthquakes.tap.json",
    port: 8802,
    domain: "geophysics",
    onboard: "npx aqueduct onboard 'https://earthquake.usgs.gov/…/all_day.csv'",
    ask: "strongest quake in the last 24h",
    request: { select: ["mag", "place"], sort: [{ field: "mag", dir: "desc" }], limit: 1 },
  },
  {
    file: "examples/fx-rates.tap.json",
    port: 8803,
    domain: "forex",
    onboard: "npx aqueduct onboard examples/fx-rates.json",
    ask: "today's USD→JPY rate",
    request: {
      select: ["currency", "rate"],
      filters: [{ field: "currency", op: "eq", value: "JPY" }],
    },
  },
];

async function main(): Promise<void> {
  console.log(
    bold("\n  AQUEDUCT — publish any data as an agent-payable API; one skill buys from any Tap\n"),
  );

  const serverPk = process.env.AQUEDUCT_SERVER_KEY ?? generatePrivateKey();
  const server = privateKeyToAccount(serverPk as `0x${string}`);
  const agentPk = process.env.AQUEDUCT_AGENT_KEY ?? generatePrivateKey();
  const agent = privateKeyToAccount(agentPk as `0x${string}`);
  const engine = await DuckDbEngine.create();

  rule("SETUP — fund the wallets (server receives, agent pays)");
  await fund(server.address, "server wallet");
  await fund(agent.address, "agent  wallet");

  // ── ACT 1: PUBLISH — every dataset is already a live, agent-payable Tap ──────
  rule("1 · PUBLISH — three datasets, three Taps (one command each · $0 LLM)");
  const servers: ReturnType<typeof serve>[] = [];
  const live: {
    url: string;
    domain: string;
    ask: string;
    config: ValidatedConfig;
    request: unknown;
  }[] = [];
  for (const t of TAPS) {
    const parsed = parseConfig(JSON.parse(readFileSync(resolve(t.file), "utf8")));
    if (!parsed.ok) throw new Error(`bad config: ${t.file}`);
    const config = {
      ...parsed.value,
      mpp: { ...parsed.value.mpp, recipient: server.address, feePayer: false },
    } as ValidatedConfig;
    servers.push(
      serve({
        fetch: createTapServer(config, engine, { account: server, rpcUrl: RPC }).fetch,
        port: t.port,
      }),
    );
    const url = `http://localhost:${t.port}`;
    live.push({ url, domain: t.domain, ask: t.ask, config, request: t.request });
    console.log(
      `  ${green("✓")} ${bold(config.name.padEnd(18))} ${dim(t.domain.padEnd(14))} ${url}`,
    );
    console.log(`     ${dim(t.onboard)}`);
  }
  console.log(
    `\n  ${dim("→ each is a declarative, eval-passed config — no API written, no payment code, no server hand-rolled.")}`,
  );

  // ── ACT 2: CONSUME — one uniform client buys from every Tap ──────────────────
  rule("2 · CONSUME — one agent, one interface, three heterogeneous Taps");
  console.log(
    `  ${dim("question:")} ${bold("closest Earth-sized exoplanet · strongest quake today · USD→JPY rate")}\n`,
  );
  let totalPaid = 0;
  const settlements: string[] = [];
  for (const t of live) {
    const r = await buyRows(t.url, t.request, { key: agentPk, rpcUrl: RPC });
    totalPaid += Number(r.amount);
    if (r.settlement) settlements.push(r.settlement);
    const answer = JSON.stringify(r.rows[0] ?? {});
    console.log(
      `  ${cyan("▸")} ${bold(t.domain.padEnd(14))} ${dim("buyRows(sameClient, tap, query)")}`,
    );
    console.log(
      `     ${green("✓")} ${t.ask}: ${bold(answer)}  ${dim(`— ${r.count} row, ${r.amount} pathUSD${r.settlement ? `, settled ${r.settlement.slice(0, 14)}…` : ""}`)}`,
    );
  }

  // ── ACT 3: the point ─────────────────────────────────────────────────────────
  rule("3 · THE POINT");
  console.log(
    `  ${dim("Taps queried:")} ${bold(String(live.length))} ${dim("· domains:")} space · geophysics · forex`,
  );
  console.log(
    `  ${dim("integrations the agent wrote:")} ${bold("0")} ${dim("— same buyRows() call for every Tap")}`,
  );
  console.log(
    `  ${dim("total paid:")} ${bold(`${totalPaid.toFixed(4)} pathUSD`)} ${dim(`· ${settlements.length} on-chain settlement${settlements.length === 1 ? "" : "s"}`)}`,
  );
  for (const s of settlements) console.log(`     ${dim(`${EXPLORER_URL}/tx/${s}`)}`);
  console.log(
    green(
      bold(
        "\n  ✓ Any dataset → one command → an agent-payable Tap. Any agent → one skill → buys from any Tap.\n" +
          "    DuckDB + MPP are the engine; the standard interface is the product. (Stripe for data → agents.)\n",
      ),
    ),
  );

  for (const s of servers) s.close();
  engine.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ showcase failed: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
