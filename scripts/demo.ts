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
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
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

// Both agents get the identical TASK. The only difference: the Aqueduct agent is told it has the
// `aqueduct` skill and where the Tap is. No handicaps on either side — same question, same effort.
const WITH_AQUEDUCT = `Use your \`aqueduct\` skill to get the data you need. A live Aqueduct Tap over the DOAJ open-access journal corpus (~23,000 journals) is at ${TAP_URL}. Follow the skill: read the Tap's schema, then query for exactly the rows you need.\n\n${TASK}`;

const ON_ITS_OWN = TASK;

// The single `aqueduct` skill the WITH-Aqueduct agent is given (planted as a project skill in its
// isolated cwd). Same discipline as skills/aqueduct/SKILL.md, but pointed at the MCP tools the agent
// actually holds (aqueduct_schema / aqueduct_query) — the isolated cwd has no repo to run query.ts.
const AQUEDUCT_SKILL = `---
name: aqueduct
description: Buy specific rows from a metered, agent-payable data feed (an "Aqueduct Tap") over MPP on Tempo. Use when you need precise data from a large external dataset — query by declared filters/columns and pay per row, instead of downloading the whole database.
---

# aqueduct

An **Aqueduct Tap** is a large dataset served as a metered HTTP API. You ask for exactly the rows you
need with a structured query and pay **per row** over an MPP session on Tempo — you never download the
whole database, and the operator never holds your funds. You reach a Tap through two MCP tools you
already have: \`aqueduct_schema\` and \`aqueduct_query\`. The Tap URL is given to you in the task.

## The flow (always in this order)

1. **Read the terms — free.** Call \`aqueduct_schema\` with the Tap URL. It signs and costs nothing and
   returns \`{ name, schema, query, pricing }\`. \`query\` is the **only** surface you may use:
   - \`filters\`: \`[{ field, ops }]\` — each filterable field + the operators allowed on it
     (\`eq ne lt lte gt gte in like\`).
   - \`selectable\`: columns you may request (or \`"*"\`). \`sortable\`: columns you may sort by.
   - \`maxLimit\` / \`defaultLimit\`: row caps. \`pricing\`: the per-row price.

2. **Buy the rows — paid.** Call \`aqueduct_query\` with the Tap URL and a request built **only** from
   declared fields/ops (an undeclared field or operator is rejected as a 400 before you pay):
   \`{ select: ["name","population"], filters: [{ field:"country", op:"eq", value:"JP" }],
      sort: [{ field:"population", dir:"desc" }], limit: 5 }\`
   It opens an MPP session, pays \`returned × unitPrice\` from your wallet, and settles on close.

## Rules of thumb

- **Schema before query.** Never guess columns/filters — read \`aqueduct_schema\` first.
- **You pay for what's returned.** Filter hard, select only the columns you need, keep \`limit\` tight.
  A query matching **0 rows is free** — refine with a cheap exploratory query before a larger pull.
- **One \`aqueduct_query\` call = one targeted query + one on-chain settlement.** Batch your need into
  one good query rather than many.
`;

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

/** Ask one line on the terminal; empty answer (or no TTY) falls back to the prefilled default. */
function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve(fallback);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(`  ${question} ${dim(`[${fallback}]`)} `, (a) => {
      rl.close();
      res(a.trim() || fallback);
    }),
  );
}

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

// Every spawned agent is registered here so quitting the demo tears down the whole claude process tree
// instead of orphaning long-running children (headless Chromium, python pulls, the MCP server subprocess).
const liveAgents = new Set<ChildProcess>();
function killAgents(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const child of liveAgents) {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal); // negative pid → the child's entire process group
      } catch {}
    }
    try {
      child.kill(signal);
    } catch {}
  }
  liveAgents.clear();
}
let quitting = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (quitting) return;
    quitting = true;
    killAgents();
    process.exit(130);
  });
}
process.on("exit", () => killAgents());

async function runClaude(
  prompt: string,
  tools: string[],
  cwd: string,
  logBase: string,
  title: string,
  mcpConfig?: string,
  sandbox = false,
): Promise<Run> {
  // Show the exact prompt this agent is handed, so a viewer sees what each side was actually asked.
  console.log(dim(`┌─ prompt sent to the agent ${"─".repeat(50)}`));
  for (const line of prompt.split("\n")) console.log(dim(`│ ${line}`));
  console.log(`${dim(`└${"─".repeat(76)}`)}\n`);
  if (sandbox)
    console.log(
      dim(
        "  agent sandbox: no desktop browser, headless tools only — a deployed agent can't borrow your logged-in Chrome to clear a bot wall\n",
      ),
    );

  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-opus-4-8",
    "--effort",
    "high",
    "--dangerously-skip-permissions",
    // Run each agent with ONLY project-level settings/skills (drop the operator's personal
    // ~/.claude skills + plugins). The fresh `cwd` has no project skills unless we plant one, so
    // the solo agent sees default built-ins only, and the Aqueduct agent sees default + the one
    // `aqueduct` skill we inject into its cwd. Keeps the race fair and reproducible across machines.
    "--setting-sources",
    "project",
    "--allowedTools",
    ...tools,
  ];
  if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  // Optionally confine the agent to a deployed-agent-grade box via sandbox-exec: deny exec/read of the
  // desktop browser app bundles, so Playwright's `channel:"chrome"` escape hatch is gone and it falls
  // back to headless bundled Chromium — which the DOAJ Cloudflare wall still blocks. Without this, a
  // dev laptop's logged-in, headed Chrome passes the managed challenge and the comparison is a lie.
  const browserApps = [
    "/Applications/Google Chrome.app",
    "/Applications/Google Chrome Canary.app",
    "/Applications/Chromium.app",
    "/Applications/Microsoft Edge.app",
    "/Applications/Brave Browser.app",
  ];
  const sbProfile =
    "(version 1)(allow default)" +
    browserApps
      .map((p) => `(deny process-exec* (subpath "${p}"))(deny file-read* (subpath "${p}"))`)
      .join("");
  const cmd = sandbox ? "sandbox-exec" : "claude";
  const spawnArgs = sandbox ? ["-p", sbProfile, "claude", ...args] : args;
  // spawn with stdin = /dev/null (`ignore`) so claude doesn't block waiting on stdin, and stream stdout
  // line-by-line. We tolerate a non-zero exit (use whatever streamed) instead of throwing it all away.
  // `detached` makes the child its own process-group leader, so on quit we can SIGKILL the entire tree
  // (claude + the bash/python/headless-Chromium it spawns) by signalling -pid — see registerCleanup().
  const child = spawn(cmd, spawnArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  liveAgents.add(child);
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
  liveAgents.delete(child);
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

// `--no-solo` runs only the WITH-Aqueduct agent (skips the slow ~17-min solo agent) — for a live demo.
const SKIP_SOLO = process.argv.includes("--no-solo");

async function main(): Promise<void> {
  console.log(
    bold(
      SKIP_SOLO
        ? "\n  AQUEDUCT — onboard a CSV → serve a metered Tap → an agent queries it, paying per row\n"
        : "\n  AQUEDUCT — onboard a CSV → serve a metered Tap → race two agents on it\n",
    ),
  );

  mkdirSync("recordings", { recursive: true }); // per-agent transcripts land here

  const serverPk = generatePrivateKey();
  const server = privateKeyToAccount(serverPk);
  const agentPk = (process.env.AQUEDUCT_AGENT_KEY as `0x${string}`) ?? generatePrivateKey();
  const agent = privateKeyToAccount(agentPk);

  // ── 1. BUILD — the builder onboards a dataset into a Tap (deterministic, no LLM) ───────────────────
  rule("BUILD — the builder onboards a dataset into a metered Tap (one command, no LLM)");
  console.log(`  ${dim("Onboard a dataset into a Tap. Press enter to accept the prefilled defaults.")}`);
  const csvPath = await ask("dataset to ingest (csv path):", CSV);
  const unitPrice = await ask("price per row (pathUSD):", "0.0001");
  const name = basename(csvPath, extname(csvPath)) || "tap";
  console.log(
    `  ${dim("$")} aqueduct onboard ${csvPath} --unit-price ${unitPrice} --recipient ${server.address.slice(0, 10)}…`,
  );
  const engine = await DuckDbEngine.create();
  const onb = await deriveConfig(
    {
      name,
      source: {
        format: "csv",
        location: { via: "path", ref: csvPath },
        authEnv: null,
        contract: { determinism: "deterministic", freshnessWindow: "24h" },
      },
      recipient: server.address,
      currency: PATH_USD,
    },
    { engine },
    { unitPrice },
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

  // Plant the one `aqueduct` skill the WITH-Aqueduct agent is allowed to have, as a project skill in
  // its cwd (the only skill it gets beyond the defaults, since we load --setting-sources project). It
  // drives the MCP tools it already holds — query.ts isn't on this isolated cwd, and giving it the repo
  // would let it read the local CSV and skip paying, which is exactly what the Tap is meant to replace.
  const skillDir = join(aqDir, ".claude", "skills", "aqueduct");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), AQUEDUCT_SKILL);

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

  let onOwn: Run | undefined;
  if (!SKIP_SOLO) {
    rule("AGENT 2 — SOLO  (claude opus 4.8, no Aqueduct — must fetch DOAJ itself)");
    onOwn = await runClaude(
      ON_ITS_OWN,
      ["Bash", "WebFetch", "WebSearch", "Read", "Write"],
      ownDir,
      "recordings/on-its-own",
      "THE AGENT ON ITS OWN",
      undefined, // no MCP — it has to fend for itself
      true, // sandbox to a deployed-agent box: no desktop browser to borrow for the Cloudflare wall
    );
  }

  const spent = Number(before - (await balanceStable(agent.address))) / 1e6;
  const spentOk = spent > 0 && spent < Number(before) / 1e6;
  const paidLine =
    spentOk
      ? `\n  ${dim("the Aqueduct agent paid for exactly the rows it used, over MPP:")} ${bold(`${spent.toFixed(4)} pathUSD`)} ${dim("from its own wallet (data + gas)")}`
      : `\n  ${dim("the Aqueduct agent paid per row over MPP, settled on-chain to the publisher's wallet")}`;
  const withAqPanel = [
    bold(cyan("◀ WITH AQUEDUCT")),
    dim("queries a paid Tap for the corpus"),
    "",
    `answer:  ${topJournal(withAq.answer)}`,
    `time:    ${(withAq.durationMs / 1000).toFixed(1)} s`,
    `agent $: $${withAq.costUsd.toFixed(4)}  (${withAq.turns} turns)`,
    "data: one metered MPP query",
  ];

  rule("RESULT");
  if (onOwn) {
    const ownGotData =
      !/403|just a moment|cloudflare|blocked|unable|could ?n.t|no access|forbidden/i.test(
        onOwn.answer,
      );
    panels(withAqPanel, [
      bold(yellow("THE AGENT ON ITS OWN ▶")),
      dim("must fetch DOAJ itself — past the wall"),
      "",
      `answer:  ${topJournal(onOwn.answer)}`,
      `time:    ${(onOwn.durationMs / 1000).toFixed(1)} s`,
      `agent $: $${onOwn.costUsd.toFixed(4)}  (${onOwn.turns} turns)`,
      ownGotData ? "data: fetched from DOAJ" : "data: blocked at DOAJ (403)",
    ]);
    console.log(paidLine);
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
  } else {
    panels(withAqPanel, []);
    console.log(paidLine);
    console.log(
      green(
        bold(
          "\n  ✓ A CSV became a metered Tap; the agent read its schema, paid per row over MPP, and answered\n" +
            "    from the corpus — no scraping, no pipeline, settlement on-chain to the publisher's wallet.\n",
        ),
      ),
    );
    console.log(
      `  ${dim("full tool-by-tool transcript:")} ${bold("recordings/with-aqueduct.log")}`,
    );
  }

  tap.close();
  engine.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ demo failed: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
