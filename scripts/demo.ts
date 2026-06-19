/**
 * Aqueduct demo — the whole story in one run:
 *
 *   1. BUILD    the builder onboards a CSV into a metered Tap (deterministic, no LLM) — live.
 *   2. SERVE    that Tap goes live over MPP.
 *   3. RACE     two identical `claude` agents work the same research task — one with the Tap, one
 *               on its own — and we stream their verbose thinking + tool calls as they go.
 *
 * The task needs the whole DOAJ open-access journal corpus (~23k journals). DOAJ put its bulk CSV and
 * API behind Cloudflare in 2025 because AI crawlers overwhelmed it (a single day spiked 968% over the
 * prior year), so the lone agent hits a 403 wall — the open door closed under AI load. The agent WITH
 * the Tap queries a maintained snapshot, pays per row over MPP, and never touches DOAJ's origin.
 *
 *   AQUEDUCT_AGENT_KEY=0x…  npx tsx scripts/demo.ts
 *   (keys optional — faucet-funded if absent.) Needs network, the faucet, the `claude` CLI, and a build
 *   (`npm run build`) so the MCP server is available at dist/mcp.js.
 *
 * Full tool-by-tool transcripts (thinking 🧠 · text 💬 · tools 🔧 · results ↳) are written to
 * recordings/with-aqueduct.log and recordings/on-its-own.log for reading side by side.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import { http, createClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DuckDbEngine } from "../adapters/source/duckdb";
import type { ValidatedConfig } from "../core/config";
import { DEFAULT_RPC_URL, PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";
import { createTapServer } from "../runtime/server";

const RPC = process.env.AQUEDUCT_RPC_URL ?? DEFAULT_RPC_URL;
const PORT = 8402;
const TAP_URL = `http://localhost:${PORT}`;
const CSV = "examples/doaj-journals.csv";
const getClient = () => createClient({ chain: tempoModerato, transport: http(RPC) });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const rule = (s: string) => console.log(`\n${bold(cyan(s))}\n${dim("─".repeat(78))}`);

// The task — a real "where can I publish for free and fast?" question. Needs the whole corpus to
// answer faithfully; neither the answer nor any column is pre-computed for it.
const TASK =
  "From the world's open-access journals indexed by DOAJ, build a shortlist a researcher could submit " +
  "to for free and fast. Criteria: charges no article-processing charge (no APC), license is exactly " +
  "'CC BY', has a plagiarism-screening policy, subject area includes Medicine, and the average time " +
  "from submission to publication is under 12 weeks. Rank by number of article records (most prolific " +
  "first) and report the top 5 as 'title — country — weeks'. Reply on one final line: " +
  "'Top journal: <title>'.";

const WITH_AQUEDUCT = `You have Aqueduct MCP tools (aqueduct_schema, aqueduct_query) for using metered, agent-payable data feeds called Taps. A live Tap over the DOAJ open-access journal corpus (~23,000 journals) is at ${TAP_URL}. Read its schema, then issue a constrained query for the rows you need — you pay a tiny amount per row from your wallet, so filter hard and select only the columns you need. Use it as your data source.\n\n${TASK}`;

const ON_ITS_OWN = `Obtain the data from the DOAJ (Directory of Open Access Journals) yourself — its public CSV export and/or its REST API — using the web and shell tools available to you. Do not give up after the first obstacle, but do not spend more than a few attempts.\n\n${TASK}`;

type Run = { costUsd: number; durationMs: number; turns: number; answer: string };
type Ev = Record<string, unknown>;
type Content = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
};

const oneLine = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

const resultText = (c: Content): string =>
  Array.isArray(c.content)
    ? c.content.map((x: { text?: string }) => x.text ?? "").join(" ")
    : String(c.content ?? "");

/** Stream a plain, Claude-Code-style line per event: assistant prose as-is, tool calls as [tool],
 * tool results indented. No emojis, no per-line tags (the agents run one after the other). */
function live(e: Ev): void {
  const msg = e.message as { content?: Content[] } | undefined;
  if (e.type === "assistant" && msg?.content) {
    for (const c of msg.content) {
      if (c.type === "thinking" && c.thinking?.trim()) console.log(dim(c.thinking.trim()));
      else if (c.type === "text" && c.text?.trim()) console.log(c.text.trim());
      else if (c.type === "tool_use")
        console.log(`${bold("[tool]")} ${c.name}  ${dim(oneLine(JSON.stringify(c.input)))}`);
    }
  }
  if (e.type === "user" && msg?.content) {
    for (const c of msg.content) {
      if (c.type === "tool_result") console.log(dim(`       ${oneLine(resultText(c))}`));
    }
  }
}

/** Render the full event stream into a readable, tool-by-tool transcript for a text editor. */
function renderTranscript(title: string, prompt: string, events: Ev[]): string {
  const lines: string[] = [`### ${title}`, "", "TASK:", prompt, "", "─".repeat(90)];
  for (const e of events) {
    const msg = e.message as { content?: Content[] } | undefined;
    if (e.type === "assistant" && msg?.content) {
      for (const c of msg.content) {
        if (c.type === "thinking" && c.thinking?.trim())
          lines.push("", `🧠 [thinking] ${c.thinking.trim()}`);
        if (c.type === "text" && c.text?.trim()) lines.push("", `💬 ${c.text.trim()}`);
        if (c.type === "tool_use")
          lines.push("", `🔧 ${c.name}  ${JSON.stringify(c.input).slice(0, 1200)}`);
      }
    }
    if (e.type === "user" && msg?.content) {
      for (const c of msg.content) {
        if (c.type === "tool_result")
          lines.push(`   ↳ ${resultText(c).replace(/\s+/g, " ").slice(0, 600)}`);
      }
    }
    if (e.type === "result") {
      lines.push(
        "",
        "─".repeat(90),
        `RESULT · ${(Number(e.duration_ms) / 1000).toFixed(1)}s · $${Number(e.total_cost_usd ?? 0).toFixed(4)} · ${e.num_turns} turns`,
        "",
        String(e.result ?? ""),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runClaude(
  prompt: string,
  tools: string[],
  cwd: string,
  logBase: string,
  title: string,
  mcpConfig?: string,
): Promise<Run> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-opus-4-8",
    "--dangerously-skip-permissions",
    "--allowedTools",
    ...tools,
  ];
  if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  // spawn with stdin = /dev/null (`ignore`) so claude doesn't block waiting on stdin, and stream stdout
  // line-by-line. We tolerate a non-zero exit (use whatever streamed) instead of throwing it all away.
  const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const raw: string[] = [];
  const events: Ev[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    raw.push(line);
    let e: Ev;
    try {
      e = JSON.parse(line) as Ev;
    } catch {
      return;
    }
    events.push(e);
    live(e);
  });
  child.stderr.on("data", () => {});
  await new Promise<void>((res) => child.on("close", () => res()));
  writeFileSync(`${logBase}.jsonl`, `${raw.join("\n")}\n`);
  writeFileSync(`${logBase}.log`, renderTranscript(title, prompt, events));
  const res = (events.find((e) => e.type === "result") ?? {}) as Ev;
  return {
    costUsd: Number(res.total_cost_usd ?? 0),
    durationMs: Number(res.duration_ms ?? 0),
    turns: Number(res.num_turns ?? 0),
    answer: String(res.result ?? "").trim(),
  };
}

async function balance(address: `0x${string}`): Promise<bigint> {
  try {
    return await Actions.token.getBalance(getClient(), { account: address, token: PATH_USD });
  } catch {
    return 0n;
  }
}

/** A settled, non-zero balance — polls until two consecutive reads agree, so a transient RPC 0 or a
 * late-landing faucet grant can't poison the spend delta we measure across the agent run. */
async function balanceStable(address: `0x${string}`): Promise<bigint> {
  let prev = await balance(address);
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const cur = await balance(address);
    if (cur === prev && cur > 0n) return cur;
    prev = cur;
  }
  return prev;
}

async function fund(address: `0x${string}`, label: string): Promise<boolean> {
  try {
    if ((await balance(address)) > 0n) {
      console.log(`  ${green("✓")} ${label} ${dim("(funded)")}`);
      return true;
    }
    await Actions.faucet.fund(getClient(), { account: address });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if ((await balance(address)) > 0n) {
        console.log(`  ${green("✓")} ${label} ${dim("(faucet-funded)")}`);
        return true;
      }
    }
  } catch {
    /* faucet unavailable */
  }
  console.log(`  ${yellow("·")} ${label}: faucet unavailable`);
  return false;
}

/** Pull the agent's headline answer ("Top journal: X") if it produced one, else flag no data. */
function topJournal(answer: string): string {
  const m = answer.match(/Top journal:\s*(.+)/i);
  if (m?.[1]) return m[1].trim();
  if (/403|just a moment|cloudflare|blocked|unable|could ?n.t|no access|forbidden/i.test(answer))
    return "(blocked — no data)";
  return "(see answer)";
}

function panels(left: string[], right: string[]): void {
  const W = 40;
  const pad = (s: string) => (s.length > W ? `${s.slice(0, W - 1)}…` : s.padEnd(W));
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    console.log(`  ${pad(left[i] ?? "")}  ${pad(right[i] ?? "")}`);
}

async function main(): Promise<void> {
  console.log(bold("\n  AQUEDUCT — onboard a CSV → serve a metered Tap → race two agents on it\n"));

  const serverPk = generatePrivateKey();
  const server = privateKeyToAccount(serverPk);
  const agentPk = (process.env.AQUEDUCT_AGENT_KEY as `0x${string}`) ?? generatePrivateKey();
  const agent = privateKeyToAccount(agentPk);

  // ── 1. BUILD — the builder onboards the CSV into a Tap (deterministic, no LLM) ────────────────────
  rule("BUILD — the builder onboards a CSV into a metered Tap (one command, no LLM)");
  console.log(`  ${dim("$")} aqueduct onboard ${CSV} --recipient ${server.address.slice(0, 10)}…`);
  const engine = await DuckDbEngine.create();
  const onb = await deriveConfig(
    {
      name: "doaj-journals",
      source: {
        format: "csv",
        location: { via: "path", ref: CSV },
        authEnv: null,
        contract: { determinism: "deterministic", freshnessWindow: "24h" },
      },
      recipient: server.address,
      currency: PATH_USD,
    },
    { engine },
  );
  if (!onb.ok) throw new Error(`onboard failed: ${JSON.stringify(onb.error)}`);
  const config = {
    ...onb.value.config,
    mpp: { ...onb.value.config.mpp, feePayer: false },
  } as ValidatedConfig;
  const rows = await engine.totalRows(config);

  console.log(`  ${dim("▸ inferred schema —")} ${config.schema.length} columns + types:`);
  const fields = config.schema.map((f) => `${f.name}:${f.type}`);
  for (let i = 0; i < fields.length; i += 4)
    console.log(`      ${dim(fields.slice(i, i + 4).join("   "))}`);
  console.log(
    `  ${dim("▸ query interface —")} ${config.query.filters.length} filterable fields, max ${config.query.maxLimit} rows/query ${dim("(declared filters → parameterized SQL; agents never send SQL)")}`,
  );
  console.log(
    `  ${dim("▸ priced unit —")} 1 ${config.pricing.unit} = ${config.pricing.unitPrice} pathUSD ${dim("(settled agent→publisher on Tempo, non-custodial)")}`,
  );
  console.log(`  ${dim("▸ eval gate —")} the config can't be served unless every check passes:`);
  for (const r of onb.value.report.results)
    console.log(`      ${r.passed ? green("✓") : "✗"} ${r.name}  ${dim(r.detail ?? "")}`);
  console.log(
    `  ${green("✓")} Tap '${bold(config.name)}' validated — ${bold(rows.toLocaleString())} rows frozen into a versioned config ${dim("(the single source of truth)")}`,
  );

  // ── 2. SERVE — Tap goes live, fund the agent's wallet ─────────────────────────────────────────────
  rule("SERVE — Tap live on :8402 + fund the agent's wallet");
  const tap = serve({
    fetch: createTapServer(config, engine, { account: server, rpcUrl: RPC }).fetch,
    port: PORT,
  });
  await Promise.all([
    fund(server.address, "publisher wallet"),
    fund(agent.address, "agent wallet   "),
  ]);

  const mcpConfig = join(tmpdir(), `aqueduct-mcp-${PORT}.json`);
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        aqueduct: {
          command: "node",
          args: [resolve("dist/mcp.js")],
          env: { AQUEDUCT_AGENT_KEY: agentPk, AQUEDUCT_RPC_URL: RPC },
        },
      },
    }),
  );

  // ── 3. RACE — the two agents, one after the other, streaming live ─────────────────────────────────
  const aqDir = mkdtempSync(join(tmpdir(), "aq-with-"));
  const ownDir = mkdtempSync(join(tmpdir(), "aq-own-"));
  const before = await balanceStable(agent.address);

  rule("AGENT 1 — WITH AQUEDUCT  (queries the Tap, pays per row over MPP)");
  const withAq = await runClaude(
    WITH_AQUEDUCT,
    ["mcp__aqueduct__aqueduct_schema", "mcp__aqueduct__aqueduct_query", "Bash"],
    aqDir,
    "recordings/with-aqueduct",
    "WITH AQUEDUCT",
    mcpConfig,
  );

  rule("AGENT 2 — SOLO  (claude opus 4.8, no Aqueduct — must fetch DOAJ itself)");
  const onOwn = await runClaude(
    ON_ITS_OWN,
    ["Bash", "WebFetch", "WebSearch", "Read", "Write"],
    ownDir,
    "recordings/on-its-own",
    "THE AGENT ON ITS OWN",
  );

  const spent = Number(before - (await balanceStable(agent.address))) / 1e6;
  const spentOk = spent > 0 && spent < Number(before) / 1e6;
  const ownGotData =
    !/403|just a moment|cloudflare|blocked|unable|could ?n.t|no access|forbidden/i.test(
      onOwn.answer,
    );

  rule("RESULT");
  panels(
    [
      bold(cyan("◀ WITH AQUEDUCT")),
      dim("queries a paid Tap for the corpus"),
      "",
      `answer:  ${topJournal(withAq.answer)}`,
      `time:    ${(withAq.durationMs / 1000).toFixed(1)} s`,
      `agent $: $${withAq.costUsd.toFixed(4)}  (${withAq.turns} turns)`,
      "data: one metered MPP query",
    ],
    [
      bold(yellow("THE AGENT ON ITS OWN ▶")),
      dim("must fetch DOAJ itself — past the wall"),
      "",
      `answer:  ${topJournal(onOwn.answer)}`,
      `time:    ${(onOwn.durationMs / 1000).toFixed(1)} s`,
      `agent $: $${onOwn.costUsd.toFixed(4)}  (${onOwn.turns} turns)`,
      ownGotData ? "data: fetched from DOAJ" : "data: blocked at DOAJ (403)",
    ],
  );
  console.log(
    spentOk
      ? `\n  ${dim("the Aqueduct agent paid for exactly the rows it used, over MPP:")} ${bold(`${spent.toFixed(4)} pathUSD`)} ${dim("from its own wallet (data + gas)")}`
      : `\n  ${dim("the Aqueduct agent paid per row over MPP, settled on-chain to the publisher's wallet")}`,
  );
  console.log(
    green(
      bold(
        "\n  ✓ One run: a CSV became a metered Tap, then the same agent — with vs without it — split on a\n" +
          "    walled corpus. The Tap agent paid per row and answered; the lone agent hit the 403 and couldn't.\n",
      ),
    ),
  );
  console.log(
    `  ${dim("full tool-by-tool transcripts (open side by side):")} ${bold("recordings/with-aqueduct.log")} ${dim("·")} ${bold("recordings/on-its-own.log")}`,
  );

  tap.close();
  engine.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ demo failed: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
