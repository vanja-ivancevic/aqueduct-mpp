/**
 * Builder pipeline for the DOAJ journals Tap.
 *
 * DOAJ (Directory of Open Access Journals) publishes a full journal-metadata CSV that regenerates
 * hourly. AI crawlers hammered DOAJ hard enough in 2025 (419% rise over a semester, a single-day spike
 * 968% over the prior year) that the bulk CSV now sits behind a Cloudflare challenge — a human browser
 * passes it, a headless agent gets a 403. So the BUILDER downloads that CSV once (manually, past the
 * wall), and this script turns it into a maintained, metered Tap that any agent can query through MPP
 * without touching DOAJ's origin. The builder owns the refresh (re-run this when a fresh CSV lands);
 * Aqueduct owns serving + metering + payment.
 *
 * Two steps, no LLM (onboarding is deterministic here):
 *   1. normalize  raw 52-column CSV → a clean, snake_case 24-column CSV snapshot
 *   2. onboard    deriveConfig() profiles the CSV → an eval-passed Tap config
 *
 *   npx tsx scripts/refresh-doaj.ts [path/to/doaj_journalcsv_*.csv] \
 *     [--unit-price <dec>]   price per row the builder charges agents (default 0.0001) — their margin
 *     [--recipient 0x…]      the builder's Tempo payout wallet (default: a placeholder)
 */
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";

const DEAD = "0x000000000000000000000000000000000000dEaD"; // placeholder payout — the builder sets theirs
const OUT_CSV = "examples/doaj-journals.csv";
const OUT_CONFIG = "examples/doaj-journals.tap.json";

// Tiny flag parser — the builder sets their own price (margin) and payout wallet, like `aqueduct onboard`.
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["unit-price", "recipient"]);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
function positional(): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a.slice(2))) i++; // skip this flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

/** Find the raw DOAJ CSV: explicit positional arg, else the newest doaj_journalcsv_*.csv under examples/. */
function findRaw(): string {
  const arg = positional();
  if (arg) return arg;
  const matches = readdirSync("examples")
    .filter((f) => /^doaj_journalcsv_.*\.csv$/i.test(f))
    .sort();
  if (matches.length === 0)
    throw new Error(
      "no examples/doaj_journalcsv_*.csv found — download it from doaj.org/csv first",
    );
  return `examples/${matches[matches.length - 1]}`;
}

// raw DOAJ column  →  clean snake_case field. Only columns a consumer would query or display; the raw
// file's URL/notes columns are dropped. read_csv_auto already infers booleans/ints correctly here.
const SELECT = `
  "Journal title"                                                              AS title,
  "Journal EISSN (online version)"                                             AS issn,
  "Journal ISSN (print version)"                                               AS issn_print,
  "Alternative title"                                                          AS alt_title,
  "Publisher"                                                                  AS publisher,
  "Country of publisher"                                                       AS publisher_country,
  "Languages in which the journal accepts manuscripts"                         AS languages,
  "Subjects"                                                                   AS subjects,
  "LCC Codes"                                                                  AS lcc_codes,
  "Keywords"                                                                   AS keywords,
  "Journal license"                                                            AS license,
  "License attributes"                                                         AS license_attributes,
  "APC"                                                                        AS has_apc,
  "APC amount"                                                                 AS apc_amount,
  "When did the journal start to publish all content using an open license?"   AS oa_start_year,
  "Review process"                                                             AS review_process,
  "Journal plagiarism screening policy"                                        AS plagiarism_screening,
  "Average number of weeks between article submission and publication"         AS weeks_to_publication,
  "Journal waiver policy (for developing country authors etc)"                 AS has_waiver,
  "Preservation Services"                                                      AS preservation,
  "Persistent article identifiers"                                             AS persistent_article_ids,
  "Does the journal comply to DOAJ's definition of open access?"               AS doaj_oa_compliant,
  "Number of Article Records"                                                  AS article_records,
  TRY_CAST("Last updated Date" AS TIMESTAMP)                                   AS last_updated`;

async function normalize(raw: string): Promise<number> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const src = `read_csv_auto('${raw}', header=true, sample_size=-1)`;
  await conn.run(`COPY (SELECT ${SELECT} FROM ${src}) TO '${OUT_CSV}' (FORMAT CSV, HEADER true)`);
  const r = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM read_csv_auto('${OUT_CSV}')`);
  conn.disconnectSync();
  inst.closeSync();
  return Number(r.getRowObjectsJson()[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const raw = findRaw();
  console.log(`normalizing ${raw} → ${OUT_CSV} …`);
  const rows = await normalize(raw);
  console.log(`  wrote ${rows.toLocaleString()} journals`);

  const unitPrice = flag("unit-price") ?? "0.0001";
  const recipient = flag("recipient") ?? DEAD;
  console.log(`onboarding ${OUT_CSV} → ${OUT_CONFIG} (deterministic, no LLM) …`);
  const engine = await DuckDbEngine.create();
  const result = await deriveConfig(
    {
      name: "doaj-journals",
      source: {
        format: "csv",
        location: { via: "path", ref: OUT_CSV },
        authEnv: null,
        contract: { determinism: "deterministic", freshnessWindow: "24h" },
      },
      recipient,
      currency: PATH_USD,
    },
    { engine },
    { unitPrice },
  );
  engine.close();

  if (!result.ok) {
    console.error("onboard failed:", JSON.stringify(result.error, null, 2));
    process.exit(1);
  }
  writeFileSync(resolve(OUT_CONFIG), `${JSON.stringify(result.value.config, null, 2)}\n`);
  const passed = result.value.report.results.filter((r) => r.passed).length;
  console.log(
    `  ✓ config written — ${passed}/${result.value.report.results.length} evals passed · price ${unitPrice}/row → ${recipient.slice(0, 8)}…`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
