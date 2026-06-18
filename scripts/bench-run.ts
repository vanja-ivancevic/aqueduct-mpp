/**
 * Cost benchmark — "what the judge asked": questions over a big dataset, answered two ways, with
 * token/dollar cost measured for each.
 *
 *   Arm A  Claude Code from scratch — given the dataset URL + a computer, it writes & runs code.
 *   Arm B  Claude Code + an Aqueduct Tap — it reads the Tap schema and forms ONE constrained query,
 *          which executes deterministically (no LLM in the data path; data billed at unitPrice/row).
 *
 * Both arms are the same model (claude-opus-4-8) driven headless via the `claude` CLI, which reports
 * token usage + USD cost per run. Correctness is checked against DuckDB ground truth.
 *
 *   npx tsx scripts/bench-run.ts <tap.json>
 *
 * The dataset is the NYC TLC yellow-taxi parquet (~3M rows) served remotely via DuckDB.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);

const DATA_URL = "https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2024-01.parquet";
const tap = process.argv[2];
if (!tap) {
  console.error("usage: bench-run.ts <tap.json>");
  process.exit(1);
}

// Needle-in-haystack questions: targeted retrievals over 3M rows. `check` validates the model's text
// against DuckDB ground truth. `rows` = how many rows the Tap returns (for the data-plane price).
const QUESTIONS: { id: string; ask: string; check: (s: string) => boolean; rows: number }[] = [
  {
    id: "fare>1000",
    ask: "How many trips had a fare_amount greater than 1000? Reply with ONLY the integer.",
    check: (s) => /\b7\b/.test(s),
    rows: 7,
  },
  {
    id: "tip>100",
    ask: "How many trips had a tip_amount greater than 100? Reply with ONLY the integer.",
    check: (s) => /\b26\b/.test(s),
    rows: 26,
  },
  {
    id: "longest-trip",
    ask: "What is the single largest trip_distance value in the dataset? Reply with ONLY the number.",
    check: (s) => s.includes("312722"),
    rows: 1,
  },
  {
    id: "max-fare",
    ask: "What is the largest fare_amount value in the dataset? Reply with ONLY the number.",
    check: (s) => /5000(\.0+)?/.test(s) || /\b5000\b/.test(s),
    rows: 1,
  },
];

const UNIT_PRICE = 0.0001;

type Run = {
  answer: string;
  costUsd: number;
  tokens: number;
  durationMs: number;
  turns: number;
  correct: boolean;
};

async function claude(prompt: string, cwd?: string): Promise<Omit<Run, "correct">> {
  const { stdout } = await pexec(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allowedTools",
      "Bash",
      "Read",
      "Write",
      "--model",
      "claude-opus-4-8",
    ],
    { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
  );
  const j = JSON.parse(stdout);
  const u = j.usage ?? {};
  const tokens =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  return {
    answer: String(j.result ?? "").trim(),
    costUsd: j.total_cost_usd ?? 0,
    tokens,
    durationMs: j.duration_ms ?? 0,
    turns: j.num_turns ?? 0,
  };
}

function armAPrompt(ask: string): string {
  return `You have a computer (Bash). The NYC yellow-taxi trip dataset for Jan 2024 is a parquet file at ${DATA_URL}. Using code (e.g. DuckDB or Python), ${ask}`;
}
function armBPrompt(ask: string): string {
  return `You have a computer (Bash) and an Aqueduct Tap over the NYC yellow-taxi dataset. Read its schema and query interface with:\n  npx tsx scripts/bench-query.ts ${tap} --schema\nThen form ONE query as JSON {select?,filters?:[{field,op,value}],sort?:[{field,dir}],limit?} (ops: eq ne lt lte gt gte in like) and run it with:\n  npx tsx scripts/bench-query.ts ${tap} '<json>'\nIt returns {count,rows}. Using only that, ${ask}`;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const results: { id: string; a: Run; b: Run; dataCost: number }[] = [];

  for (const q of QUESTIONS) {
    process.stderr.write(`\n▸ ${q.id}\n`);
    process.stderr.write("  Arm A (from scratch) …\n");
    const aRaw = await claude(armAPrompt(q.ask), cwd);
    const a: Run = { ...aRaw, correct: q.check(aRaw.answer) };
    process.stderr.write(
      `    $${a.costUsd.toFixed(4)}  ${a.tokens} tok  ${a.turns} turns  ${a.correct ? "✓" : "✗ " + a.answer.slice(0, 40)}\n`,
    );

    process.stderr.write("  Arm B (Aqueduct Tap) …\n");
    const bRaw = await claude(armBPrompt(q.ask), cwd);
    const b: Run = { ...bRaw, correct: q.check(bRaw.answer) };
    const dataCost = q.rows * UNIT_PRICE;
    process.stderr.write(
      `    $${b.costUsd.toFixed(4)} agent + $${dataCost.toFixed(4)} data  ${b.tokens} tok  ${b.turns} turns  ${b.correct ? "✓" : "✗ " + b.answer.slice(0, 40)}\n`,
    );

    results.push({ id: q.id, a, b, dataCost });
  }

  // ── report ──
  const fmt = (n: number) => `$${n.toFixed(4)}`;
  console.log("\n# Cost benchmark — NYC taxi (2.96M rows), claude-opus-4-8\n");
  console.log(
    "| question | Arm A $ | A tok | A ok | Arm B agent $ | B data $ | B tok | B ok | A/B cost |",
  );
  console.log("|---|--:|--:|:-:|--:|--:|--:|:-:|--:|");
  let aTot = 0,
    bTot = 0,
    aTok = 0,
    bTok = 0,
    aOk = 0,
    bOk = 0;
  for (const r of results) {
    const bTotal = r.b.costUsd + r.dataCost;
    const ratio = bTotal > 0 ? (r.a.costUsd / bTotal).toFixed(1) : "—";
    console.log(
      `| ${r.id} | ${fmt(r.a.costUsd)} | ${r.a.tokens} | ${r.a.correct ? "✓" : "✗"} | ${fmt(r.b.costUsd)} | ${fmt(r.dataCost)} | ${r.b.tokens} | ${r.b.correct ? "✓" : "✗"} | ${ratio}x |`,
    );
    aTot += r.a.costUsd;
    bTot += bTotal;
    aTok += r.a.tokens;
    bTok += r.b.tokens;
    aOk += r.a.correct ? 1 : 0;
    bOk += r.b.correct ? 1 : 0;
  }
  console.log(`\n**Totals (${results.length} questions):**`);
  console.log(
    `- Arm A (from scratch): ${fmt(aTot)}, ${aTok} tokens, ${aOk}/${results.length} correct`,
  );
  console.log(
    `- Arm B (Aqueduct Tap): ${fmt(bTot)} (${fmt(bTot - results.reduce((s, r) => s + r.dataCost, 0))} agent + ${fmt(results.reduce((s, r) => s + r.dataCost, 0))} data), ${bTok} tokens, ${bOk}/${results.length} correct`,
  );
  console.log(
    `- **Aqueduct is ${(aTot / bTot).toFixed(1)}x cheaper** at the agent+data level. Onboarding the Tap was deterministic ($0 LLM). The data plane itself runs $0 LLM (invariant 1).`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
