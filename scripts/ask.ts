/**
 * LLM-asks-a-big-database demo — the core use case, end to end, on REAL data.
 *
 *   npx tsx scripts/ask.ts ["your natural-language question"]
 *
 * A real LLM (Claude, via the CLI) answers a natural-language question by USING the aqueduct skill on
 * a live Tap of NASA's exoplanet archive (~1,500 confirmed planets): it discovers the Tap's terms for
 * free, translates the question into a constrained query, BUYS exactly the rows it needs per-row over
 * an MPP session, and answers from them — never touching the rest of the dataset. The skill tool
 * (skills/aqueduct/query.ts) is invoked as a subprocess, exactly as a Claude Code agent would. Live on
 * Tempo testnet.
 *
 * Fast/repeatable recordings: set AQUEDUCT_SERVER_KEY + AQUEDUCT_AGENT_KEY to pre-funded wallets and
 * the faucet wait is skipped entirely.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { claudeCli } from "../adapters/llm/cli";
import { DuckDbEngine } from "../adapters/source/duckdb";
import type { Source } from "../core/config";
import { DEFAULT_RPC_URL, EXPLORER_URL, PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";
import { extractJson } from "../core/onboard";
import { createTapServer } from "../runtime/server";

// Async exec: the Tap server runs in THIS process's event loop, so the skill subprocess (which calls
// back into it over HTTP) must not be launched with a *sync* exec — that would block the loop and the
// server couldn't answer. promisified execFile keeps the loop serving while the subprocess runs.
const pexec = promisify(execFile);

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const PORT = 8700;
const BASE = `http://localhost:${PORT}`;
const DATASET = resolve("examples/exoplanets.csv");
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const step = (n: number, t: string) =>
  console.log(`\n${bold(cyan(`  ${n}  ${t}`))}\n  ${dim("─".repeat(64))}`);

const balanceOf = (address: `0x${string}`) =>
  Actions.token.getBalance(getClient(), { account: address, token: PATH_USD });

/** Ensure the wallet holds pathUSD. A pre-funded wallet (recording mode) skips the faucet entirely. */
async function ensureFunded(address: `0x${string}`, label: string): Promise<void> {
  try {
    if ((await balanceOf(address)) > 0n) {
      console.log(`  ${green("✓")} ${label} ${dim("(pre-funded)")}`);
      return;
    }
  } catch {
    /* token account uninitialized until first credit */
  }
  await Actions.faucet.fund(getClient(), { account: address });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if ((await balanceOf(address)) > 0n) {
        console.log(`  ${green("✓")} ${label} ${dim("(faucet-funded)")}`);
        return;
      }
    } catch {
      /* still uninitialized */
    }
  }
  throw new Error(`faucet timeout for ${label}`);
}

// Appended to every prompt: the demo invokes the local `claude` CLI, which may carry session personas
// (e.g. a "caveman" plugin) — force plain professional English so the demo output stays clean.
const PLAIN =
  " Respond in clear, professional English. Do not use any persona, slang, roleplay, or abbreviated 'caveman' style.";

const BASELINE_SYSTEM =
  "You are an AI assistant with NO internet, database, or tool access — only your training knowledge. " +
  "Answer the user's question with your single best answer, and briefly note how confident you are. " +
  "Be concise: at most 3 sentences." +
  PLAIN;

const QUERY_SYSTEM =
  "You are a data agent with access to an Aqueduct Tap (a paid, metered dataset). " +
  "Given the Tap's JSON schema and a user question, output ONLY a JSON query object that answers it, " +
  "using ONLY declared fields and the operators each field allows. Shape: " +
  '{"select":[...],"filters":[{"field","op","value"}],"sort":[{"field","dir"}],"limit":N}. ' +
  "You pay per returned row — keep limit tight. Output the JSON object and nothing else." +
  PLAIN;

const ANSWER_SYSTEM =
  "You are an astronomer. Answer the user's question from the provided JSON rows only, concisely. " +
  "State the answer plainly with the relevant numbers; note anything notable about the planets." +
  PLAIN;

async function main(): Promise<void> {
  const question =
    process.argv[2] ??
    "What is the closest exoplanet to Earth discovered by the Transit method with a temperate equilibrium temperature (between 250 and 320 K)? Give the 3 nearest, with name, distance (pc), temperature, and host star.";
  console.log(
    bold("\n  AQUEDUCT — an LLM buys specific data from a big Tap (via the aqueduct skill)\n"),
  );
  console.log(`  ${dim("dataset:")} NASA exoplanet archive (real)   ${dim("question:")}`);
  console.log(`  ${bold(question)}`);

  const llm = claudeCli();

  // ── 0. BASELINE — the same question with NO data access (what agents do today) ──────────────────
  step(0, "WITHOUT AQUEDUCT — the agent answers from memory alone (no data)");
  const baseline = await llm.complete({ system: BASELINE_SYSTEM, input: question });
  console.log(
    baseline.ok
      ? baseline.value
          .trim()
          .split("\n")
          .map((l) => `  ${dim(l)}`)
          .join("\n")
      : `  ${dim("(baseline step failed)")}`,
  );

  const engine = await DuckDbEngine.create();
  const serverPk = process.env.AQUEDUCT_SERVER_KEY ?? generatePrivateKey();
  const server = privateKeyToAccount(serverPk as `0x${string}`);
  let httpServer: ReturnType<typeof serve> | undefined;
  try {
    // ── 1. compile + serve the Tap ─────────────────────────────────────────────
    step(1, "SERVE — compile the exoplanet archive into a Tap and run it");
    const source: Source = {
      format: "csv",
      location: { via: "path", ref: DATASET },
      authEnv: null,
      contract: { determinism: "deterministic", freshnessWindow: "24h" },
    };
    const built = await deriveConfig(
      { name: "exoplanets", source, recipient: server.address, currency: PATH_USD },
      { engine },
    );
    if (!built.ok) throw new Error(`onboarding failed: ${JSON.stringify(built.error)}`);
    const config = built.value.config;
    const total = await engine.totalRows(config);
    await ensureFunded(server.address, "server wallet");
    httpServer = serve({
      fetch: createTapServer(config, engine, { account: server, rpcUrl: RPC }).fetch,
      port: PORT,
    });
    console.log(
      `  ${green("✓")} ${bold(`${total.toLocaleString()} planets`)} live on ${BASE}  ${dim(`(${config.pricing.unitPrice} pathUSD/row)`)}`,
    );

    // ── 2. agent discovers terms — FREE (the skill's --schema path) ────────────
    step(2, "DISCOVER — the agent reads the Tap's terms for free (skill: --schema)");
    const { stdout: schemaJson } = await pexec(
      "npx",
      ["tsx", "skills/aqueduct/query.ts", BASE, "--schema"],
      { encoding: "utf8" },
    );
    console.log(
      `  ${dim("columns:")} ${config.schema.map((f) => `${f.name}:${f.type}`).join("  ")}`,
    );

    // ── 3. the LLM turns the question into a constrained query ──────────────────
    step(3, "PLAN — the LLM translates the question into a paid query");
    const planned = await llm.complete({
      system: QUERY_SYSTEM,
      input: `Schema:\n${schemaJson}\n\nQuestion: ${question}`,
    });
    if (!planned.ok) throw new Error(`LLM planning failed: ${planned.error.message}`);
    const query = extractJson(planned.value);
    if (!query) throw new Error(`LLM did not return a JSON query:\n${planned.value}`);
    console.log(`  ${dim("LLM query →")} ${cyan(JSON.stringify(query))}`);

    // ── 4. buy exactly those rows — PAID (the skill's paid path) ────────────────
    step(4, "BUY — the agent pays per row over an MPP session (skill: paid query)");
    const agentPk = process.env.AQUEDUCT_AGENT_KEY ?? generatePrivateKey();
    const agent = privateKeyToAccount(agentPk as `0x${string}`);
    await ensureFunded(agent.address, "agent wallet");
    const { stdout: out } = await pexec(
      "npx",
      ["tsx", "skills/aqueduct/query.ts", BASE, JSON.stringify(query)],
      {
        encoding: "utf8",
        env: { ...process.env, AQUEDUCT_AGENT_KEY: agentPk, AQUEDUCT_RPC_URL: RPC },
      },
    );
    const result = JSON.parse(out) as {
      count: number;
      paid: string;
      settlement: string | null;
      rows: unknown[];
    };
    console.log(
      `  ${green("✓")} bought ${bold(`${result.count} rows`)} for ${bold(result.paid)}  ${dim(`settled ${result.settlement?.slice(0, 18)}…`)}`,
    );
    if (result.settlement) console.log(`      ${dim(`${EXPLORER_URL}/tx/${result.settlement}`)}`);

    // ── 5. the LLM answers from the rows it paid for ───────────────────────────
    step(5, "ANSWER — the LLM answers from only the rows it bought");
    const answered = await llm.complete({
      system: ANSWER_SYSTEM,
      input: `Question: ${question}\n\nRows:\n${JSON.stringify(result.rows)}`,
    });
    console.log(
      `  ${answered.ok ? answered.value.trim() : `(answer step failed: ${answered.error.message})`}`,
    );

    // ── the contrast ───────────────────────────────────────────────────────────
    step(6, "THE DIFFERENCE");
    console.log(
      `  ${dim("without Aqueduct:")} a guess from training memory — plausible, unverifiable, stale`,
    );
    console.log(
      `  ${dim("with Aqueduct:")}    ${result.count} exact rows from the live archive, ${result.paid}, settled on-chain — verifiable + current`,
    );
    console.log(
      green(
        bold(
          `\n  ✓ DONE — answered from ${result.count} paid rows, never touching the other ${(total - result.count).toLocaleString()}.\n`,
        ),
      ),
    );
  } finally {
    httpServer?.close();
    engine.close();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ ask failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
