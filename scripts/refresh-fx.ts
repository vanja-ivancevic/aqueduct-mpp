/**
 * Example builder refresh pipeline — the job Aqueduct does NOT own (CLAUDE.md: builder owns the
 * updater; the Tap serves whatever snapshot it writes, honoring the freshness window).
 *
 * Fetches ECB daily reference rates from Frankfurter and flattens the nested `{ rates: {...} }` object
 * into one row per currency. A vendor runs this on a daily cron; consumers then micro-buy a single
 * rate without ever touching the source or maintaining this pipeline themselves.
 *
 *   npx tsx scripts/refresh-fx.ts   # writes examples/fx-rates.json
 */
import { writeFileSync } from "node:fs";

async function main(): Promise<void> {
  const base = "USD";
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}`);
  const d = (await res.json()) as { base: string; date: string; rates: Record<string, number> };
  const rows = Object.entries(d.rates).map(([currency, rate]) => ({
    base: d.base,
    currency,
    rate,
    date: d.date,
  }));
  writeFileSync("examples/fx-rates.json", JSON.stringify(rows, null, 0));
  console.log(`wrote ${rows.length} FX rates (base ${d.base}, ${d.date})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
