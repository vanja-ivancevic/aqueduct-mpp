/**
 * Example builder refresh pipeline (see also refresh-fx.ts) — the updater Aqueduct does NOT own.
 *
 * Pulls the previous day's top-viewed English Wikipedia articles from the Wikimedia REST API and
 * flattens `items[0].articles` into a clean table, dropping the Main Page and Special: pseudo-pages
 * (vendor curation) so rank 1 is a real article. A daily cron writes this; consumers micro-buy a slice
 * ("yesterday's top 10") without holding the Wikimedia User-Agent contract or the unnest logic.
 *
 *   npx tsx scripts/refresh-pageviews.ts   # writes examples/wiki-pageviews.json
 */
import { writeFileSync } from "node:fs";

// Pinned to a finalized day (the API finalizes ~05:00 UTC the next day). A real cron would compute
// yesterday; pinned here so the committed fixture is reproducible.
const DAY = "2026/06/17";

async function main(): Promise<void> {
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${DAY}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "aqueduct-demo/0.1 (https://github.com/your-org/aqueduct)" },
  });
  const d = (await res.json()) as {
    items: {
      year: string;
      month: string;
      day: string;
      articles: { article: string; views: number; rank: number }[];
    }[];
  };
  const it = d.items[0];
  const date = `${it.year}-${it.month}-${it.day}`;
  const rows = it.articles
    .filter((a) => a.article !== "Main_Page" && !a.article.startsWith("Special:"))
    .map((a, i) => ({ rank: i + 1, article: a.article.replace(/_/g, " "), views: a.views, date }));
  writeFileSync("examples/wiki-pageviews.json", JSON.stringify(rows, null, 0));
  console.log(
    `wrote ${rows.length} articles (${date}); #1 = ${rows[0]?.article} (${rows[0]?.views} views)`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
