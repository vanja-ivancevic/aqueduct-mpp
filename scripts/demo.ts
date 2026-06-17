/**
 * Aqueduct end-to-end demo — the whole vertical in one command, live on Tempo testnet.
 *
 *   npx tsx scripts/demo.ts            # uses examples/cities.csv
 *   npx tsx scripts/demo.ts my.csv     # any parquet/csv/json
 *
 * It (1) COMPILES a raw file into a Tap (deterministic, no LLM), (2) SERVES it, (3) an AGENT
 * discovers terms for free and pays per row over an MPP session — twice on one channel, the second
 * served from cache — then (4) SETTLES the cumulative voucher on-chain. Funds throwaway wallets from
 * the public faucet, so it needs only network access.
 */
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { tempo } from "mppx/client";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { type Source, inferFormat } from "../core/config";
import { DEFAULT_RPC_URL, EXPLORER_URL as EXPLORER, PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";
import { createTapServer } from "../runtime/server";

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
function step(n: number, title: string) {
  console.log(`\n${bold(cyan(`  ${n}  ${title}`))}\n  ${dim("─".repeat(60))}`);
}

async function fund(address: `0x${string}`, label: string) {
  await Actions.faucet.fund(getClient(), { account: address });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const bal = await Actions.token.getBalance(getClient(), {
        account: address,
        token: PATH_USD,
      });
      if (bal > 0n) return console.log(`  ${green("✓")} ${label} funded ${dim(address)}`);
    } catch {
      /* uninitialized until first credit */
    }
  }
  throw new Error(`timed out funding ${label}`);
}

async function main() {
  const file = resolve(process.argv[2] ?? "examples/cities.csv");
  console.log(bold("\n  AQUEDUCT — dataset → metered, agent-payable Tap (MPP on Tempo)\n"));

  // ── 1. compile ──────────────────────────────────────────────────────────
  step(1, "COMPILE — profile the file into a Tap config (deterministic, no LLM)");
  const engine = await DuckDbEngine.create();
  const server = privateKeyToAccount(generatePrivateKey());
  const source: Source = {
    format: inferFormat(file) ?? "csv",
    location: { via: "path", ref: file },
    authEnv: null,
    contract: { determinism: "deterministic", freshnessWindow: "24h" },
  };
  const built = await deriveConfig(
    { name: "cities", source, recipient: server.address, currency: PATH_USD },
    { engine },
  );
  if (!built.ok) throw new Error(`onboarding failed: ${JSON.stringify(built.error)}`);
  const config = built.value.config;
  console.log(`  file:     ${dim(file)}`);
  console.log(`  schema:   ${config.schema.map((f) => `${f.name}:${f.type}`).join("  ")}`);
  console.log(`  filters:  ${config.query.filters.map((f) => f.field).join(", ")}`);
  console.log(`  price:    ${bold(config.pricing.unitPrice)} pathUSD / row`);
  console.log(
    `  evals:    ${green(`${built.value.report.results.filter((r) => r.passed).length}/${built.value.report.results.length} passed`)} (score ${built.value.report.score.toFixed(2)})`,
  );

  // ── 2. serve ────────────────────────────────────────────────────────────
  step(2, "SERVE — run the Tap (free /schema, paid /query over MPP sessions)");
  await fund(server.address, "server wallet");
  const app = createTapServer(config, engine, { account: server, rpcUrl: RPC });
  const port = 8500;
  const http_server = serve({ fetch: app.fetch, port });
  const base = `http://localhost:${port}`;
  const schema = (await (await globalThis.fetch(`${base}/schema`)).json()) as { pricing: unknown };
  console.log(`  ${green("✓")} live on ${base}`);
  console.log(`  GET /schema (free) → ${dim(JSON.stringify(schema.pricing))}`);

  // ── 3. agent pays ─────────────────────────────────────────────────────────
  step(3, "AGENT — discover terms, then pay per row over an MPP session");
  const agent = privateKeyToAccount(generatePrivateKey());
  await fund(agent.address, "agent wallet");

  // re-wrap to an extensible Response (the session manager assigns receipt/cumulative onto it)
  const extensibleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await globalThis.fetch(input, init);
    const nullBody = r.status === 204 || r.status === 304;
    return new Response(nullBody ? null : await r.arrayBuffer(), {
      status: r.status,
      headers: r.headers,
    });
  }) as typeof fetch;
  const session = tempo.session.manager({
    account: agent,
    getClient,
    maxDeposit: "1",
    fetch: extensibleFetch,
  });

  const q = (req: unknown) =>
    `${base}/query?q=${Buffer.from(JSON.stringify(req)).toString("base64url")}`;
  const ask = {
    filters: [{ field: "country", op: "eq", value: "JP" }],
    sort: [{ field: "population", dir: "desc" }],
  };
  console.log(`  query: ${dim('cities where country = "JP", by population desc')}`);

  const calls = [
    { tag: "#1", note: "first call — opens the channel, signs a voucher" },
    { tag: "#2", note: "same query — served from cache, fresh voucher" },
  ];
  for (const { tag, note } of calls) {
    const res = (await session.fetch(q(ask), { method: "GET" })) as Response & {
      cumulative?: bigint;
    };
    const body = (await res.json()) as {
      rows: { name: string }[];
      count: number;
      amount: string;
      cached: boolean;
    };
    console.log(`  ${bold(tag)} ${dim(note)}`);
    console.log(
      `      → ${res.status}  rows=${body.count}  paid=${bold(`${body.amount} pathUSD`)}  ` +
        `cache=${body.cached ? green("HIT") : "miss"}  cumulative=${dim(String(res.cumulative))}`,
    );
    if (tag === "#1") console.log(`      ${dim(`→ ${body.rows.map((r) => r.name).join(", ")}`)}`);
  }

  // ── 4. settle ─────────────────────────────────────────────────────────────
  step(4, "SETTLE — close the channel; the cumulative voucher settles on-chain");
  const receipt = (await session.close()) as { reference?: string } | undefined;
  const ref = receipt?.reference;
  console.log(
    `  ${green("✓")} settled on Tempo  ${ref ? `\n      channel: ${dim(ref)}\n      explorer: ${cyan(`${EXPLORER}/tx/${ref}`)}` : ""}`,
  );

  console.log(
    green(
      bold(
        "\n  ✓ DONE — a raw CSV became a live, agent-paid data feed. Real value moved on-chain.\n",
      ),
    ),
  );
  http_server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ demo failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
