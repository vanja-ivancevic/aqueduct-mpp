/**
 * Live testnet payment smoke (manual, not part of the test suite).
 *
 * Proves the full vertical end-to-end against Tempo Moderato:
 *   onboard'd Tap  →  agent hits /query  →  402 challenge  →  mppx opens a session, pays a voucher
 *   →  200 + rows + receipt  →  on-chain channel settles.
 *
 * Run:  npx tsx scripts/pay-smoke.ts <config.tap.json>
 * Needs network + the public faucet. Funds a fresh client wallet and the server's fee-payer wallet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { tempo } from "mppx/client";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { parseConfig } from "../core/config";
import { DEFAULT_RPC_URL, PATH_USD } from "../core/constants";
import { validate } from "../core/evals";
import { createTapServer } from "../runtime/server";

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

async function fundAndWait(address: `0x${string}`, label: string) {
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
        console.log(`  ✓ ${label} balance ${bal.toString()}`);
        return;
      }
    } catch {
      /* uninitialized until first credit */
    }
  }
  throw new Error(`timed out funding ${label}`);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: tsx scripts/pay-smoke.ts <config.tap.json>");

  // ── load + eval-gate the Tap, exactly like `aqueduct serve` ──
  const parsed = parseConfig(JSON.parse(readFileSync(resolve(configPath), "utf8")));
  if (!parsed.ok) throw new Error(`config invalid: ${JSON.stringify(parsed.error.issues)}`);
  const engine = await DuckDbEngine.create();
  const gate = await validate(parsed.value, engine);
  if (!gate.ok) throw new Error("config fails evals");

  // ── server wallet (receives settlement, sponsors gas as feePayer) ──
  const serverKey = (process.env.AQUEDUCT_PRIVATE_KEY ?? generatePrivateKey()) as `0x${string}`;
  const serverAccount = privateKeyToAccount(serverKey);
  // recipient → server wallet for the smoke. feePayer OFF: the agent self-pays gas. On Moderato today
  // this is the clean path — sponsored (feePayer:true) settle currently trips "fee payer cannot
  // resolve to sender" in mppx, and the sponsor gas caps need lifting (see createTapServer).
  const config = {
    ...gate.config,
    mpp: { ...gate.config.mpp, recipient: serverAccount.address, feePayer: false },
  };

  await fundAndWait(serverAccount.address, "server/feePayer");

  const app = createTapServer(config as typeof gate.config, engine, {
    account: serverAccount,
    rpcUrl: RPC,
  });
  const port = 8499;
  const loggedFetch = async (req: Request) => {
    const res = await app.fetch(req);
    console.log(
      `    [srv] ${req.method} ${new URL(req.url).pathname}${new URL(req.url).search ? "?…" : ""} → ${res.status}`,
    );
    return res;
  };
  const server = serve({ fetch: loggedFetch, port });
  const base = `http://localhost:${port}`;
  console.log(`▸ Tap '${config.name}' serving on ${base}`);

  // ── client agent wallet ──
  const clientAccount = privateKeyToAccount(generatePrivateKey());
  await fundAndWait(clientAccount.address, "client/agent");

  // The manager does `Object.assign(response, {receipt, cumulative})`; a live fetch Response is
  // non-extensible, so re-wrap into a fresh (extensible) Response that preserves status/headers/body.
  const extensibleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await globalThis.fetch(input, init);
    const buf = await r.arrayBuffer();
    // 204/304/101 are null-body statuses; the Response ctor rejects a body for them.
    const nullBody = r.status === 204 || r.status === 304 || r.status === 101;
    return new Response(nullBody ? null : buf, {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
    });
  }) as typeof fetch;

  // The Sessions manager keeps ONE TIP-1034 channel open across calls: lazy-open on first 402,
  // cumulative vouchers per request, settle on close. This is the per-row micropayment primitive.
  const session = tempo.session.manager({
    account: clientAccount,
    getClient,
    maxDeposit: "1",
    fetch: extensibleFetch,
  });

  // Agent request rides in a base64url `q` param on GET (content path).
  const q = (request: unknown) => Buffer.from(JSON.stringify(request)).toString("base64url");
  const queryUrl = (request: unknown) => `${base}/query?q=${q(request)}`;

  // ── unpaid probe → expect 402 (request must match >0 rows so a charge is due) ──
  const probe = await globalThis.fetch(queryUrl({ limit: 1 }));
  console.log(
    `▸ unpaid probe → ${probe.status} (${probe.status === 402 ? "challenge, good" : "unexpected"})`,
  );

  // ── paid request via mppx (auto 402 → session → pay → retry) ──
  const url = queryUrl({ limit: 3 });
  type Body = { rows?: unknown[]; count?: number; amount?: string; cached?: boolean };

  async function paidQuery(label: string): Promise<Body> {
    const res = (await session.fetch(url, { method: "GET" })) as Response & {
      cumulative?: unknown;
      receipt?: unknown;
    };
    const body = (await res.json()) as Body;
    console.log(
      `▸ ${label} → ${res.status}  rows:${body.count}  amount:${body.amount}  cached:${body.cached}` +
        `  cumulative:${String(res.cumulative ?? "?")}`,
    );
    if (res.status !== 200) throw new Error(`expected 200 after payment, got ${res.status}`);
    return body;
  }

  // Two paid requests on ONE channel. The server advertises a suggestedDeposit covering the whole
  // session, so the channel opens large enough that NO mid-session top-up is needed — the second
  // request rides a fresh cumulative voucher and is served from cache.
  console.log("▸ paying via MPP session …");
  const first = await paidQuery("paid #1 (cache miss)");
  const second = await paidQuery("paid #2 (cache hit)");

  console.log("▸ closing session (settles the cumulative voucher on-chain) …");
  const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  const closeReceipt = await session.close();
  console.log(`  closed/settled: ${JSON.stringify(closeReceipt, bigintSafe).slice(0, 180)}`);

  if (first.cached !== false) throw new Error("first paid request should be a cache miss");
  if (second.cached !== true) throw new Error("second identical request should be a cache hit");
  console.log(
    "\n✓ SMOKE PASSED — 402 → session pay ×2 (cumulative vouchers, no top-up) → cache hit → on-chain settle",
  );
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n✗ smoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
