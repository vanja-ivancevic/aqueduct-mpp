/**
 * Gallery benchmark — the strong case, across data *types*. For each example Tap we ask the SAME
 * natural-language question two ways and measure cost + speed (+ a soft correctness check):
 *
 *   Arm A  Claude Code from scratch — given ONLY the question + a computer (no URL). It must discover
 *          where the data lives, fetch it live, and compute the answer.
 *   Arm B  the Aqueduct Tap data plane — plan one constrained query, execute via DuckDB. No LLM in the
 *          path (invariant 1); data billed at unitPrice/row.
 *
 * Arm A is the real `claude` CLI (reports tokens + USD + wall-clock). Arm B is timed warm (the served
 * cache-hit path). Correctness is a soft check: does Arm A's answer mention the Tap's key fact? For
 * fast-moving / snapshot feeds it's marked n/a (both can be "right" against different live windows).
 *
 *   npx tsx scripts/bench-gallery.ts [name-substring]   # filter to one dataset, e.g. `exoplanets`
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { parseConfig } from "../core/config";
import { unitsCost } from "../core/pricing";
import { planQuery, queryPolicy } from "../core/query";

const pexec = promisify(execFile);

type Row = Record<string, unknown>;
type Case = {
  tap: string;
  domain: string;
  /** why Claude struggles here — the axis this dataset exercises */
  axis: string;
  question: string;
  gt: unknown;
  /** the needle to look for in Arm A's prose, or null to skip (snapshot/fast-moving) */
  key: (rows: Row[]) => string | null;
};

const GALLERY: Case[] = [
  {
    tap: "examples/exoplanets.tap.json",
    domain: "space science",
    axis: "hard to FETCH (NASA TAP / ADQL, not a known URL)",
    question:
      "What is the single closest Earth-sized exoplanet to Earth, counting only confirmed planets " +
      "with a radius between 0.8 and 1.5 Earth radii? Give its name and its distance in parsecs.",
    gt: {
      select: ["name", "distance_pc"],
      filters: [
        { field: "radius_earth", op: "gte", value: 0.8 },
        { field: "radius_earth", op: "lte", value: 1.5 },
      ],
      sort: [{ field: "distance_pc", dir: "asc" }],
      limit: 1,
    },
    key: (rows) => String(rows[0]?.name ?? "").split(/\s+/)[0] || null, // e.g. "Proxima"
  },
  {
    tap: "examples/usgs-earthquakes.tap.json",
    domain: "geophysics",
    axis: "FRESH (sub-minute) — yesterday's copy is wrong",
    question:
      "What was the strongest earthquake anywhere in the world in the last 24 hours? " +
      "Give its magnitude and the place name.",
    gt: { select: ["mag", "place"], sort: [{ field: "mag", dir: "desc" }], limit: 1 },
    key: (rows) => {
      const place = String(rows[0]?.place ?? "");
      return (
        place
          .split(/,|\s+of\s+/)
          .pop()
          ?.trim() || null
      ); // the region, e.g. "Philippines"
    },
  },
  {
    tap: "examples/nasa-neo.tap.json",
    domain: "planetary defense",
    axis: "nested JSON needing FLATTEN/assembly",
    question:
      "Using NASA's Near-Earth Object data, list the potentially hazardous asteroids making a close " +
      "approach to Earth in the next 7 days, with each one's closest miss distance in lunar distances.",
    gt: {
      select: ["name", "miss_distance_lunar"],
      filters: [{ field: "is_potentially_hazardous", op: "eq", value: true }],
    },
    key: () => null, // static snapshot vs Claude's live week — cost/speed only, correctness n/a
  },
  {
    tap: "examples/fx-rates.tap.json",
    domain: "foreign exchange",
    axis: "vendor-maintained daily snapshot (ECB reference rates)",
    question:
      "Using the ECB euro foreign-exchange reference rates, what is today's US dollar to Japanese " +
      "yen (USD to JPY) rate? Give the number.",
    gt: { select: ["currency", "rate"], filters: [{ field: "currency", op: "eq", value: "JPY" }] },
    key: (rows) => (rows[0] ? String(Math.round(Number(rows[0].rate))) : null), // e.g. "157"
  },
  {
    tap: "examples/wiki-pageviews.tap.json",
    domain: "culture / web",
    axis: "nested JSON + daily; stable ranking",
    question:
      "What was the single most-viewed English Wikipedia article on 2026-06-17, excluding the Main " +
      "Page and special pages? Give the exact article title.",
    gt: { select: ["rank", "article"], sort: [{ field: "rank", dir: "asc" }], limit: 1 },
    key: (rows) => String(rows[0]?.article ?? "") || null,
  },
];

type ArmA = { costUsd: number; durationMs: number; tokens: number; turns: number; answer: string };

async function claude(prompt: string): Promise<ArmA> {
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
      "WebFetch",
      "WebSearch",
      "--model",
      "claude-opus-4-8",
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
  );
  const j = JSON.parse(stdout);
  const u = j.usage ?? {};
  return {
    costUsd: j.total_cost_usd ?? 0,
    durationMs: j.duration_ms ?? 0,
    tokens:
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
    turns: j.num_turns ?? 0,
    answer: String(j.result ?? "").trim(),
  };
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  const cases = GALLERY.filter((c) => !filter || c.tap.includes(filter));
  const engine = await DuckDbEngine.create();
  const results: {
    c: Case;
    rows: number;
    dataUsd: number;
    tapMs: number;
    a: ArmA;
    correct: boolean | null;
  }[] = [];

  for (const c of cases) {
    process.stderr.write(`\n▸ ${c.domain} (${c.tap})\n`);
    const parsed = parseConfig(JSON.parse(readFileSync(resolve(c.tap), "utf8")));
    if (!parsed.ok) throw new Error(`bad config: ${c.tap}`);
    const config = parsed.value;
    const planned = planQuery(config, c.gt, queryPolicy(config));
    if (!planned.ok) throw new Error(`bad gt query for ${c.tap}`);

    // Arm B — Tap data plane, timed warm (the served cache-hit path).
    const rows = (await engine.query(config, planned.value)) as Row[];
    const t = performance.now();
    await engine.query(config, planned.value);
    const tapMs = performance.now() - t;
    const dataUsd = Number(unitsCost(config.pricing.unitPrice, rows.length));
    const keyStr = c.key(rows);
    process.stderr.write(
      `  Tap: ${rows.length} rows  $${dataUsd.toFixed(4)}  ${tapMs.toFixed(0)}ms  key=${keyStr ?? "(n/a)"}\n`,
    );

    // Arm A — Claude from scratch.
    process.stderr.write("  Claude from scratch …\n");
    const a = await claude(c.question);
    const correct = keyStr
      ? new RegExp(keyStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(a.answer)
      : null;
    process.stderr.write(
      `    $${a.costUsd.toFixed(4)}  ${(a.durationMs / 1000).toFixed(1)}s  ${a.turns} turns  ${
        correct === null ? "correctness n/a" : correct ? "✓ match" : "✗ no match"
      }\n`,
    );
    results.push({ c, rows: rows.length, dataUsd, tapMs, a, correct });
  }
  engine.close();

  // ── report ──
  console.log("\n# Gallery benchmark — Claude-from-scratch vs Aqueduct Tap (claude-opus-4-8)\n");
  console.log(
    "| dataset | why Claude struggles | Claude $ | Claude time | Tap $ | Tap time | cost× | speed× | match |",
  );
  console.log("|---|---|--:|--:|--:|--:|--:|--:|:-:|");
  for (const r of results) {
    const costX = r.dataUsd > 0 ? Math.round(r.a.costUsd / r.dataUsd) : "—";
    const speedX = r.tapMs > 0 ? Math.round(r.a.durationMs / r.tapMs) : "—";
    console.log(
      `| ${r.c.domain} | ${r.c.axis} | $${r.a.costUsd.toFixed(4)} | ${(r.a.durationMs / 1000).toFixed(1)}s | ` +
        `$${r.dataUsd.toFixed(4)} | ${r.tapMs.toFixed(0)}ms | ${costX}× | ${speedX}× | ${
          r.correct === null ? "n/a" : r.correct ? "✓" : "✗"
        } |`,
    );
  }
  const tot = results.reduce((s, r) => s + r.a.costUsd, 0);
  const totData = results.reduce((s, r) => s + r.dataUsd, 0);
  const x = totData > 0 ? Math.round(tot / totData) : "—";
  const claude = tot.toFixed(4);
  const tap = totData.toFixed(4);
  console.log(
    `\n**Totals:** Claude $${claude} vs Tap data $${tap} — ${x}× cheaper at the data-delivery layer. Onboarding + data plane run $0 LLM (invariant 1).`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
