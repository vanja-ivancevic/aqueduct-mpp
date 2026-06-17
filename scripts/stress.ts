/**
 * Stress test — throw 5 unrelated, structurally varied datasets at the system and see what holds.
 *
 *   npx tsx scripts/stress.ts
 *
 * Generates (deterministically, via DuckDB) five files of different formats / sizes / shapes, then
 * runs each through the REAL data plane — deterministic onboarding (`deriveConfig`), the query planner
 * (`planQuery`, the security perimeter), the DuckDB adapter, and the cache — exactly as the paid hot
 * path does, minus the MPP charge (payment is proven in scripts/e2e.ts). Per-file isolation: one bad
 * dataset is reported, not fatal. No network. Asserts correctness + measures latency.
 *
 * The five (chosen to break things, not flatter them):
 *   1. wide.csv        — 40 columns, 5k rows, ints/doubles/strings/timestamps + injected NULLs
 *   2. events.ndjson   — 50k rows, NESTED struct column + unicode (tests json-typed fields)
 *   3. catalog.json    — JSON array, 2k rows, NULL titles, emoji/special chars
 *   4. txns.parquet    — 200k rows, typed binary columns (size / hot-path perf)
 *   5. weird.csv       — 3 rows, a SPACE in a column name, leading-zero ids, an all-empty column
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbEngine } from "../adapters/source/duckdb";
import type { FieldSpec, FileFormat, Source } from "../core/config";
import { PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";
import { planQuery, queryPolicy } from "../core/query";
import { cacheKey, memoryCache } from "../runtime/cache";

const RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type Spec = { name: string; file: string; format: FileFormat; note: string };

async function generate(dir: string): Promise<Spec[]> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const run = (sql: string) => conn.run(sql);

  // 1. wide.csv — 40 mixed columns with NULLs sprinkled in
  const wide: string[] = [];
  for (let k = 0; k < 40; k++) {
    if (k % 4 === 0) wide.push(`(i * ${k + 1})::BIGINT AS n${k}`);
    else if (k % 4 === 1)
      wide.push(`(CASE WHEN i % 5 = 0 THEN NULL ELSE i * 0.${k + 1} END)::DOUBLE AS f${k}`);
    else if (k % 4 === 2) wide.push(`('val_' || (i % 100)) AS s${k}`);
    else wide.push(`(TIMESTAMP '2024-01-01' + (i * INTERVAL 1 MINUTE)) AS t${k}`);
  }
  const wideFile = join(dir, "wide.csv");
  await run(
    `COPY (SELECT ${wide.join(", ")} FROM range(5000) t(i)) TO '${wideFile}' (HEADER, DELIMITER ',')`,
  );

  // 2. events.ndjson — nested struct + unicode, newline-delimited JSON
  const eventsFile = join(dir, "events.ndjson");
  await run(
    `COPY (SELECT i AS id, ('user_☃_' || (i % 1000)) AS username,
       {'kind': 'evt' || (i % 5), 'weight': i % 100} AS payload,
       (TIMESTAMP '2024-01-01' + (i * INTERVAL 1 SECOND)) AS ts
     FROM range(50000) t(i)) TO '${eventsFile}' (FORMAT json)`,
  );

  // 3. catalog.json — JSON array, NULL titles, emoji/special chars
  const catalogFile = join(dir, "catalog.json");
  await run(
    `COPY (SELECT i AS sku,
       (CASE WHEN i % 3 = 0 THEN NULL ELSE 'Pröduct ☕ #' || i END) AS title,
       (i % 2 = 0) AS in_stock, (i * 9.99)::DOUBLE AS price
     FROM range(2000) t(i)) TO '${catalogFile}' (FORMAT json, ARRAY true)`,
  );

  // 4. txns.parquet — 200k typed rows
  const txnsFile = join(dir, "txns.parquet");
  await run(
    `COPY (SELECT i AS txn_id, (i % 5000) AS account, (i * 1.0001)::DOUBLE AS amount,
       (i % 2 = 0) AS settled, (TIMESTAMP '2020-01-01' + (i * INTERVAL 1 MINUTE)) AS created
     FROM range(200000) t(i)) TO '${txnsFile}' (FORMAT parquet)`,
  );

  // 5. weird.csv — degenerate edges, written by hand
  const weirdFile = join(dir, "weird.csv");
  writeFileSync(
    weirdFile,
    "id,full name,amount,note,empty_col\n" +
      '007,"Doe, Jane",0042,"He said ""hi"" ☕",\n' +
      "008,Анна,1000,plain,\n" +
      "009,,55,no name,\n",
  );

  conn.disconnectSync();
  inst.closeSync();

  return [
    { name: "wide-sensors", file: wideFile, format: "csv", note: "40 cols, 5k rows, NULLs" },
    { name: "events", file: eventsFile, format: "json", note: "50k rows, nested struct, unicode" },
    { name: "catalog", file: catalogFile, format: "json", note: "JSON array, NULL titles, emoji" },
    { name: "txns", file: txnsFile, format: "parquet", note: "200k rows, typed binary" },
    { name: "weird", file: weirdFile, format: "csv", note: "3 rows, space-in-colname, edges" },
  ];
}

type Report = {
  name: string;
  format: string;
  rows: number;
  cols: number;
  evals: string;
  battery: string;
  perf: string;
  status: string;
};

function firstOf(schema: FieldSpec[], ...types: FieldSpec["type"][]): FieldSpec | undefined {
  return schema.find((f) => types.includes(f.type));
}

async function testSpec(spec: Spec): Promise<Report> {
  const engine = await DuckDbEngine.create();
  const checks: string[] = [];
  let assertions = 0;
  const must = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`[${spec.name}] ${label}`);
    assertions += 1;
  };
  try {
    const source: Source = {
      format: spec.format,
      location: { via: "path", ref: spec.file },
      authEnv: null,
      contract: { determinism: "deterministic", freshnessWindow: "24h" },
    };
    const built = await deriveConfig(
      { name: spec.name, source, recipient: RECIPIENT, currency: PATH_USD },
      { engine },
    );
    if (!built.ok) {
      return { ...emptyRow(spec), status: red(`onboard FAILED: ${JSON.stringify(built.error)}`) };
    }
    const config = built.value.config;
    const policy = queryPolicy(config);
    const schema = config.schema;
    const total = await engine.totalRows(config);

    // a) empty request → declared columns, default limit honored
    const empty = planQuery(config, {}, policy);
    must("empty plan ok", empty.ok);
    if (empty.ok) {
      const rows = await engine.query(config, empty.value);
      must("default-limit respected", rows.length <= config.query.defaultLimit);
      must(
        "returns declared columns",
        rows.length === 0 || Object.keys(rows[0]).every((k) => schema.some((f) => f.name === k)),
      );
    }

    // b) numeric filter + sort desc + select + limit → bounded, ordered
    const numF = firstOf(schema, "integer", "number");
    if (numF) {
      const req = {
        filters: [{ field: numF.name, op: "gte", value: 0 }],
        sort: [{ field: numF.name, dir: "desc" }],
        limit: 5,
      };
      const p = planQuery(config, req, policy);
      must("numeric filter/sort plans", p.ok);
      if (p.ok) {
        const rows = await engine.query(config, p.value);
        must("limit caps the window", rows.length <= 5);
        const vals = rows.map((r) => Number(r[numF.name])).filter((v) => !Number.isNaN(v));
        must(
          "sorted descending",
          vals.every((v, i) => i === 0 || vals[i - 1] >= v),
        );
      }
    }

    // c) LIKE on a string field with a real sampled prefix
    const strF = firstOf(schema, "string");
    if (strF && config.query.filters.some((f) => f.field === strF.name && f.ops.includes("like"))) {
      const sample = (await engine.sampleRaw(source, 1))[0]?.[strF.name];
      const prefix =
        typeof sample === "string" && sample.length >= 2 ? `${sample.slice(0, 2)}%` : "%";
      const p = planQuery(
        config,
        { filters: [{ field: strF.name, op: "like", value: prefix }] },
        policy,
      );
      must("like plans", p.ok);
      if (p.ok) await engine.query(config, p.value); // must not throw
    }

    // d) impossible predicate → 0 rows (and no charge upstream)
    if (numF) {
      const p = planQuery(
        config,
        { filters: [{ field: numF.name, op: "gte", value: 1e18 }] },
        policy,
      );
      must("impossible filter plans", p.ok);
      if (p.ok)
        must("impossible filter → 0 rows", (await engine.countMatching(config, p.value)) === 0);
    }

    // e) offset past the end → 0 rows
    const offP = planQuery(config, { offset: 9_000_000 }, policy);
    must("huge offset plans (clamped)", offP.ok);
    if (offP.ok)
      must("offset past end → 0 rows", (await engine.countMatching(config, offP.value)) === 0);

    // f) SECURITY: an undeclared column must be rejected by the planner
    must("undeclared select rejected", !planQuery(config, { select: ["__nope__"] }, policy).ok);

    // g) limit clamp: an absurd limit is clamped to maxLimit, never unbounded
    const clampP = planQuery(config, { limit: 10_000_000 }, policy);
    must("absurd limit plans", clampP.ok);
    if (clampP.ok) must("limit clamped to maxLimit", clampP.value.limit === config.query.maxLimit);

    checks.push(`${assertions} asserts`);

    // perf: cold count+query vs warm cache hit (the server's exact cache logic)
    const fullPlan = planQuery(config, { limit: config.query.maxLimit }, policy);
    if (!fullPlan.ok) throw new Error("full plan failed");
    const ns = `${config.name}:${config.source.location.ref}`;
    const key = cacheKey(fullPlan.value, ns);
    const cache = memoryCache(60_000);
    const t0 = performance.now();
    await engine.countMatching(config, fullPlan.value);
    const rows = await engine.query(config, fullPlan.value);
    cache.set(key, rows);
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    const hit = cache.get(key);
    const hitMs = performance.now() - t1;
    must("cache hit returns rows", Boolean(hit) && hit?.length === rows.length);

    return {
      name: config.name,
      format: spec.format,
      rows: total,
      cols: schema.length,
      evals: `${(built.value.report.score * 100).toFixed(0)}% (${built.value.report.results.length} checks)`,
      battery: green(`${assertions}/${assertions} pass`),
      perf: `cold ${coldMs.toFixed(0)}ms · hit ${hitMs.toFixed(2)}ms`,
      status: green("OK"),
    };
  } catch (e) {
    return {
      ...emptyRow(spec),
      battery: red("FAIL"),
      status: red(e instanceof Error ? e.message : String(e)),
    };
  } finally {
    engine.close();
  }
}

function emptyRow(spec: Spec): Report {
  return {
    name: spec.name,
    format: spec.format,
    rows: 0,
    cols: 0,
    evals: "-",
    battery: "-",
    perf: "-",
    status: "-",
  };
}

async function main(): Promise<void> {
  console.log(bold("\n  AQUEDUCT — stress test across 5 varied datasets\n"));
  const dir = mkdtempSync(join(tmpdir(), "aqueduct-stress-"));
  try {
    const specs = await generate(dir);
    for (const s of specs)
      console.log(`  ${dim("generated")} ${s.file.split("/").pop()}  ${dim(s.note)}`);
    console.log();

    const reports: Report[] = [];
    for (const spec of specs) {
      process.stdout.write(`  ${dim("testing")} ${spec.name} … `);
      const r = await testSpec(spec);
      reports.push(r);
      console.log(r.status.includes("OK") ? green("OK") : r.status);
    }

    console.log(bold("\n  Results\n"));
    for (const r of reports) {
      console.log(
        `  ${bold(r.name.padEnd(14))} ${r.format.padEnd(8)} ${String(r.rows).padStart(7)} rows  ${String(r.cols).padStart(3)} cols`,
      );
      console.log(
        `  ${dim("".padEnd(14))} evals ${r.evals.padEnd(20)} ${r.battery.padEnd(22)} ${dim(r.perf)}`,
      );
      if (!r.status.includes("OK")) console.log(`  ${red(`→ ${r.status}`)}`);
    }

    const ok = reports.filter((r) => r.status.includes("OK")).length;
    console.log(
      ok === reports.length
        ? green(bold(`\n  ✓ ${ok}/${reports.length} datasets held up.\n`))
        : red(bold(`\n  ✗ ${ok}/${reports.length} OK — see failures above.\n`)),
    );
    process.exitCode = ok === reports.length ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(red(`\n  stress harness crashed: ${e instanceof Error ? e.stack : e}\n`));
  process.exit(1);
});
