/**
 * End-to-end USER test — drives the real shipped surface, not the library.
 *
 *   npx tsx scripts/e2e.ts
 *
 * Unlike scripts/demo.ts (which wires the library in one process), this exercises the actual user
 * journey as separate processes over HTTP, with hard assertions at every step:
 *   1. builder runs `aqueduct onboard <csv>` (CLI) → a Tap config file
 *   2. builder runs `aqueduct serve <config>` (CLI, separate process) → a live HTTP Tap
 *   3. a raw unpaid agent hits the gates: free /schema, free zero-row, 402 on a billable query
 *   4. a paying agent opens an MPP session, pays per row twice (miss then cache hit), settles on-chain
 * Exit 0 = every assertion held. Funds throwaway wallets from the faucet; needs network access.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tempo } from "mppx/client";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DEFAULT_RPC_URL, EXPLORER_URL, PATH_USD } from "../core/constants";

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const PORT = 8600;
const BASE = `http://localhost:${PORT}`;
const CONFIG = "/tmp/aqueduct-e2e.tap.json";
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) throw new Error(`assertion failed: ${label}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`  ${green("✓")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
}

async function fund(address: `0x${string}`, label: string): Promise<void> {
  await Actions.faucet.fund(getClient(), { account: address });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const bal = await Actions.token.getBalance(getClient(), {
        account: address,
        token: PATH_USD,
      });
      if (bal > 0n) return;
    } catch {
      /* uninitialized until first credit */
    }
  }
  throw new Error(`timed out funding ${label}`);
}

const enc = (req: unknown) => Buffer.from(JSON.stringify(req)).toString("base64url");

async function waitForServer(deadlineMs: number): Promise<void> {
  while (Date.now() < deadlineMs) {
    try {
      const r = await fetch(`${BASE}/schema`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become ready");
}

async function main(): Promise<void> {
  console.log("\n  AQUEDUCT — end-to-end user test (real CLI, over HTTP)\n");
  rmSync(CONFIG, { force: true });

  const serverPk = generatePrivateKey();
  const server = privateKeyToAccount(serverPk);
  await fund(server.address, "server wallet");

  // ── 1. builder: onboard via the CLI ────────────────────────────────────────
  execFileSync(
    "npx",
    [
      "tsx",
      "cli/index.ts",
      "onboard",
      "examples/cities.csv",
      "--recipient",
      server.address,
      "--out",
      CONFIG,
    ],
    { stdio: "inherit" },
  );
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as {
    version: number;
    name: string;
    pricing: { unitPrice: string };
    schema: unknown[];
  };
  check("onboard wrote a v1 config", config.version === 1, `name=${config.name}`);
  check(
    "config carries a schema + price",
    config.schema.length > 0,
    `${config.pricing.unitPrice}/row`,
  );

  // ── 2. builder: serve via the CLI (separate process) ───────────────────────
  let child: ChildProcess | undefined;
  try {
    child = spawn("npx", ["tsx", "cli/index.ts", "serve", CONFIG], {
      env: {
        ...process.env,
        AQUEDUCT_PRIVATE_KEY: serverPk,
        AQUEDUCT_SECRET: generatePrivateKey().slice(2),
        AQUEDUCT_RPC_URL: RPC,
        PORT: String(PORT),
      },
      stdio: "inherit",
      // Own process group so we can reap the whole npx→tsx→node tree on teardown (a plain
      // child.kill only hits the npx shim and leaves the real server orphaned).
      detached: true,
    });
    await waitForServer(Date.now() + 30_000);
    check("CLI `serve` is live", true, BASE);

    // ── 3. raw unpaid agent — exercise the gates over real HTTP ───────────────
    const schemaRes = await fetch(`${BASE}/schema`);
    const schema = (await schemaRes.json()) as Record<string, unknown>;
    check("GET /schema is free (200)", schemaRes.status === 200);
    check("/schema discloses terms, not rows", "pricing" in schema && !("rows" in schema));

    const zero = await fetch(
      `${BASE}/query?q=${enc({ filters: [{ field: "population", op: "gte", value: 9e9 }] })}`,
    );
    const zeroBody = (await zero.json()) as { count: number; amount: string };
    check(
      "zero-row query is free",
      zero.status === 200 && zeroBody.count === 0 && zeroBody.amount === "0",
    );

    const badReq = await fetch(
      `${BASE}/query?q=${enc({ filters: [{ field: "nope", op: "eq", value: 1 }] })}`,
    );
    check("undeclared filter rejected (400)", badReq.status === 400);

    const unpaid = await fetch(
      `${BASE}/query?q=${enc({ filters: [{ field: "country", op: "eq", value: "JP" }] })}`,
    );
    check("billable query without payment is gated (402)", unpaid.status === 402);

    // ── 4. paying agent — MPP session, pay per row, settle ────────────────────
    const agent = privateKeyToAccount(generatePrivateKey());
    await fund(agent.address, "agent wallet");

    // re-wrap to an extensible Response (the session manager assigns receipt/cumulative onto it)
    const extensibleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await fetch(input, init);
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

    const ask = {
      filters: [{ field: "country", op: "eq", value: "JP" }],
      sort: [{ field: "population", dir: "desc" }],
    };
    const url = `${BASE}/query?q=${enc(ask)}`;

    const r1 = (await session.fetch(url, { method: "GET" })) as Response;
    const b1 = (await r1.json()) as { count: number; amount: string; cached: boolean };
    check("paid call #1 served rows", r1.status === 200 && b1.count === 2, `paid ${b1.amount}`);
    check("paid call #1 was a cache miss", b1.cached === false);

    const r2 = (await session.fetch(url, { method: "GET" })) as Response;
    const b2 = (await r2.json()) as { count: number; amount: string; cached: boolean };
    check("paid call #2 served from cache", b2.cached === true && b2.count === 2);
    check("cache hit bills the same amount", b2.amount === b1.amount, b2.amount);

    const receipt = (await session.close()) as { reference?: string } | undefined;
    check("session settled on-chain", Boolean(receipt?.reference), receipt?.reference);
    if (receipt?.reference) console.log(`      ${dim(`${EXPLORER_URL}/tx/${receipt.reference}`)}`);

    console.log(green(`\n  ✓ PASS — ${passed} assertions held across the real CLI user journey\n`));
  } finally {
    // Negative pid → signal the whole process group (reaps npx + tsx + node).
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    rmSync(CONFIG, { force: true });
  }
}

main().catch((e) => {
  console.error(red(`\n  ✗ E2E FAILED: ${e instanceof Error ? e.message : e}\n`));
  process.exit(1);
});
