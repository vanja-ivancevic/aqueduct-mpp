/**
 * Duel — the same RECURRING data task, two Claude Code agents, side by side. The point isn't a
 * one-shot question; it's a job that repeats ("every 2h, the earthquakes over magnitude X in the last
 * 2h"). One agent has the **aqueduct skill + a live Tap**; the other has only a computer. Both are
 * Claude Code (real `claude` CLI, verbose), so the only variable is the Tap.
 *
 *   Arm A — no Tap:   must discover USGS, fetch, parse the CSV, compute the time window, filter. Every
 *                     cycle it re-derives all of that (or you hand-maintain a brittle scraper).
 *   Arm B — Tap:      reads the Tap's schema once, forms ONE constrained query, buys the rows over MPP.
 *                     The recurring cost collapses to a deterministic $0-LLM re-run of that query.
 *
 *   AQUEDUCT_SERVER_KEY=0x… AQUEDUCT_AGENT_KEY=0x…  npx tsx scripts/duel.ts [cycles]
 *   (keys optional — funded from the faucet if absent. default cycles = 2.)
 *
 * Needs network + the public faucet. Each Arm-B cycle settles a real MPP session on Tempo testnet.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { parseConfig } from "../core/config";
import { DEFAULT_RPC_URL, PATH_USD } from "../core/constants";
import { createTapServer } from "../runtime/server";

const pexec = promisify(execFile);
const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const PORT = 8711;
const BASE = `http://localhost:${PORT}`;
const TAP = resolve("examples/usgs-earthquakes.tap.json");
const CYCLES = Math.max(1, Number(process.argv[2] ?? 2));
const MAG = 4.5;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const rule = (s: string) => console.log(`\n${bold(cyan(s))}\n${dim("─".repeat(72))}`);

const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

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

type Step = { tool: string; detail: string };
type Run = { steps: Step[]; answer: string; costUsd: number; turns: number; durationMs: number };

/** Run a real Claude Code agent (verbose stream) and extract its tool-use steps + cost/turns/answer. */
async function claude(prompt: string, tools: string[], env?: NodeJS.ProcessEnv): Promise<Run> {
  const { stdout } = await pexec(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      ...tools,
      "--model",
      "claude-opus-4-8",
    ],
    { maxBuffer: 128 * 1024 * 1024, timeout: 300_000, env: { ...process.env, ...env } },
  );
  const steps: Step[] = [];
  let answer = "";
  let costUsd = 0;
  let turns = 0;
  let durationMs = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      const msg = ev.message as {
        content?: { type: string; name?: string; input?: Record<string, unknown> }[];
      };
      for (const b of msg.content ?? []) {
        if (b.type === "tool_use")
          steps.push({ tool: b.name ?? "?", detail: summarize(b.name ?? "", b.input ?? {}) });
      }
    } else if (ev.type === "result") {
      answer = String(ev.result ?? "").trim();
      costUsd = Number(ev.total_cost_usd ?? 0);
      turns = Number(ev.num_turns ?? 0);
      durationMs = Number(ev.duration_ms ?? 0);
    }
  }
  return { steps, answer, costUsd, turns, durationMs };
}

function summarize(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown) =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 84);
  if (tool === "Bash") return s(input.command);
  if (tool === "WebFetch") return s(input.url ?? input.prompt);
  if (tool === "WebSearch") return s(input.query);
  if (tool === "Write" || tool === "Read" || tool === "Edit") return s(input.file_path);
  return s(JSON.stringify(input));
}

function printRun(label: string, color: (s: string) => string, r: Run): void {
  console.log(color(bold(`  ${label}`)));
  if (r.steps.length === 0) console.log(`    ${dim("(no tool calls)")}`);
  for (const [i, st] of r.steps.entries()) {
    console.log(
      `    ${dim(String(i + 1).padStart(2))} ${bold(st.tool.padEnd(9))} ${dim(st.detail)}`,
    );
  }
  console.log(
    `    ${dim("→")} ${r.turns} turns · ${(r.durationMs / 1000).toFixed(1)}s · ${bold(`$${r.costUsd.toFixed(4)}`)}`,
  );
}

async function main(): Promise<void> {
  console.log(
    bold("\n  DUEL — a RECURRING data task, two Claude Code agents (one has an Aqueduct Tap)\n"),
  );
  console.log(`  ${dim("task:")} every 2h, report worldwide earthquakes ≥ M${MAG} in the last 2h`);
  console.log(`  ${dim("both:")} Claude Code (claude-opus-4-8). only difference: the Tap.\n`);

  // ── boot a live, paid earthquake Tap (for Arm B) ───────────────────────────
  const parsed = parseConfig(JSON.parse(readFileSync(TAP, "utf8")));
  if (!parsed.ok) throw new Error("bad tap config");
  const serverPk = process.env.AQUEDUCT_SERVER_KEY ?? generatePrivateKey();
  const server = privateKeyToAccount(serverPk as `0x${string}`);
  const config = {
    ...parsed.value,
    mpp: { ...parsed.value.mpp, recipient: server.address, feePayer: false },
  };
  const engine = await DuckDbEngine.create();
  rule("SETUP — boot the live earthquake Tap + fund wallets");
  await fund(server.address, "server wallet");
  const agentPk = process.env.AQUEDUCT_AGENT_KEY ?? generatePrivateKey();
  const agent = privateKeyToAccount(agentPk as `0x${string}`);
  await fund(agent.address, "agent wallet");
  const httpServer = serve({
    fetch: createTapServer(config, engine, { account: server, rpcUrl: RPC }).fetch,
    port: PORT,
  });
  console.log(
    `  ${green("✓")} Tap live on ${BASE} ${dim(`(${config.pricing.unitPrice} pathUSD/row)`)}`,
  );

  const taskA =
    `You are a monitoring agent. Report every earthquake worldwide with magnitude ${MAG} or greater ` +
    `in the LAST 2 HOURS. For each: magnitude, place, time (UTC). Use real current data. Output a short ` +
    `markdown table, or "none" if there are none. Be efficient — this exact task repeats every 2 hours.`;
  const taskB =
    `You are a monitoring agent. You have the Aqueduct skill and a live earthquake Tap at ${BASE}. ` +
    `Report every earthquake worldwide with magnitude ${MAG} or greater in the LAST 2 HOURS (magnitude, ` +
    `place, time UTC) as a short markdown table, or "none". Use ONLY the Tap:\n` +
    `  1. read its schema:  npx tsx skills/aqueduct/query.ts ${BASE} --schema\n` +
    `  2. form one constrained query (filter mag >= ${MAG} and time >= now-2h) and buy the rows:\n` +
    `       npx tsx skills/aqueduct/query.ts ${BASE} '<request-json>'   (env AQUEDUCT_AGENT_KEY is set)\n` +
    `  3. answer from the returned rows. This exact task repeats every 2 hours.`;

  const a: Run[] = [];
  const b: Run[] = [];
  let bDataRows = 0;
  try {
    for (let c = 1; c <= CYCLES; c++) {
      rule(`CYCLE ${c} / ${CYCLES}`);
      console.log(yellow("  ▸ Arm A (no Tap) working…"));
      const ra = await claude(taskA, ["Bash", "WebFetch", "WebSearch", "Read", "Write"]);
      printRun("ARM A — Claude Code, no Tap", yellow, ra);
      a.push(ra);

      console.log(cyan("\n  ▸ Arm B (Aqueduct Tap) working…"));
      const rb = await claude(taskB, ["Bash", "Read"], {
        AQUEDUCT_AGENT_KEY: agentPk,
        AQUEDUCT_RPC_URL: RPC,
      });
      printRun("ARM B — Claude Code + Aqueduct Tap", cyan, rb);
      b.push(rb);
      // the deterministic recurring cost: once the query is known, re-running it needs no LLM.
      const m = rb.answer.match(/M?\s?\d\.\d/g);
      bDataRows = Math.max(bDataRows, m ? m.length : 0);
    }
  } finally {
    httpServer.close();
    engine.close();
  }

  // ── the verdict: recurrence is where "just use an agent" stops being practical ──
  rule("THE RECURRING COST (this is the point)");
  const avgA = a.reduce((s, r) => s + r.costUsd, 0) / a.length;
  const avgB = b.reduce((s, r) => s + r.costUsd, 0) / b.length;
  const unit = Number(config.pricing.unitPrice);
  const dataPerCycle = Math.max(bDataRows, 1) * unit; // deterministic re-run of the known query, $0 LLM
  console.log(
    `  ${dim("measured per cycle:")}  Arm A ${bold(`$${avgA.toFixed(4)}`)}   Arm B (with LLM) ${bold(`$${avgB.toFixed(4)}`)}`,
  );
  console.log(
    `  ${dim("but Arm B's recurring path needs no LLM:")} the query is known after cycle 1 → re-run it`,
  );
  console.log(
    `  ${dim("deterministically for")} ${bold(`$${dataPerCycle.toFixed(4)}`)} ${dim("/cycle ($0 LLM).")}\n`,
  );
  console.log(`  ${dim("projected cumulative cost:")}`);
  console.log(
    `  ${dim("cycles".padEnd(10))} ${"Arm A (re-derive each cycle)".padEnd(30)} Arm B (form once, re-run)`,
  );
  for (const n of [1, 12, 360, 4380]) {
    const costA = n * avgA;
    const costB = avgB + (n - 1) * dataPerCycle;
    const label = n === 12 ? "1 day" : n === 360 ? "1 month" : n === 4380 ? "1 year" : "1×";
    console.log(
      `  ${String(n).padEnd(10)} ${`$${costA.toFixed(2)}`.padEnd(30)} $${costB.toFixed(2)}   ${dim(`(${label}, every 2h)`)}`,
    );
  }
  console.log(
    green(
      bold(
        `\n  ✓ Both are Claude Code. The agent without a Tap re-derives a brittle fetch every cycle;\n` +
          `    with a Tap it forms one query, then the recurrence is a deterministic $0-LLM read.\n`,
      ),
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ duel failed: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
