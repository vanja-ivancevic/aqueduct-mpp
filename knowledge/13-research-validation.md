# 13 — Research Validation (4 Sonnet agents, 2026-06-17)

Parallel validation of engine, payment pipeline, landscape, and reuse. Verdicts + decisions below.

## 1. Query engine — DuckDB VALIDATED

Keep DuckDB; it's the only option satisfying all four needs at once: native parquet/CSV/JSON read +
full SQL + HTTP Range predicate/projection pushdown + reliable prebuilt binaries (incl. musl/Alpine,
arm64). Alternatives fail ≥1 axis: SQLite (no native parquet, needs ETL), Polars (no SQL engine),
chDB (52★, no musl), Arrow JS (not a query engine), LanceDB (vector DB), DataFusion (no Node bindings).

- **Use `@duckdb/node-api@1.5.3-r.3`** (MIT, DuckDB Labs, Promise-native, prebuilt per-platform binaries).
  **NOT** the old `duckdb` package (node-gyp, Alpine/musl install failures).
- Risks + mitigations: pin exact version (the `-r.N` cadence can drift) + commit lockfile; init a
  **module-level singleton connection + warmup `SELECT 1`** at startup (one-time ~20–80ms engine init,
  not per-request); musl binary is newer → test on `node:alpine` if deploying there. SQLite
  (`better-sqlite3`) remains the fallback (costs file→sqlite ETL, loses live-URL mode).

## 2. mppx payment pipeline — CONFIRMED, with 3 real constraints

All five assumptions confirmed against `vendor/mpp` + docs, but with precisions that change the MVP:

- **Per-row streaming uses SSE.** `withReceipt(async function*…)` with `stream.charge()` per yield
  requires `tempo.session({ …, sse: true })`. The **client/agent must speak SSE**, not plain fetch.
  → **MVP bills per-query instead:** one `mppx.session({ amount, unitType:'row' })` charge per request
  with `amount = rows × unitPrice` computed dynamically, single response, **no SSE**. Per-row SSE
  streaming = stretch wow. (Big de-risk.)
- **`Store.memory()` is process-local + ephemeral** — channel state lost on restart → stale 402s AND
  loss of *unsettled* revenue (server forgets un-settled vouchers; on-chain channels are still safe).
  Real deploy needs `Store.redis()` / `Store.upstash()` / `Store.cloudflare()`. Memory = local demo only.
  NB: **`Store` ≠ Akash.** Akash = where the server *runs* (compute); `Store` = where session *state*
  persists. On Akash (restartable) you still need an external/persistent Store (managed redis/upstash,
  or a redis sidecar with a persistent volume) + aggressive `settlementSchedule` to bound state-at-risk.
  Three layers for a hosted Tap: compute (Akash) + state (Store) + settlement (Tempo).
- **Version flag — RESOLVED (2026-06-17):** installed **`mppx@0.7.0`** from npm and inspected its API.
  `tempo.session` IS present (with `charge/sessionLegacy/subscription/settle/settleBatch/Ws`), as are
  `Store`, `Mppx`, `Response` (`mppx/server`) and the `mppx/hono` middleware (`Mppx, tempo, payment,
  discovery`). `tempo.session` params confirmed: `account, chainId, currency, recipient, feePayer,
  store, settlementSchedule, channelStateTtl, sse, minVoucherDelta, resolveChannelId, bootstrap`.
  Per-route option = `{ amount: string, unitType: string, currency?, recipient? }`. **No PR build
  needed.** NB: the per-route `amount` is a *static string*, so our **dynamic per-query amount
  (rows×price) needs the MANUAL server flow** (compute amount per request → `mppx.session({amount})(req)`
  → if 402 return challenge, else `withReceipt`). Pure pricing math = `core/pricing.ts` `unitsCost()`.
- Confirmed: `settlementSchedule {amount?, intervalMs?, units?}` (background batched on-chain settle);
  `feePayer` (account | URL | true) sponsors agent gas; Moderato **42431** + pathUSD
  `0x20c0…0000`; middlewares `mppx/hono|express|nextjs|elysia`, bare `mppx/server`.
- Gotchas: `channelStateTtl` (~5s) triggers RPC checks during long streams (point `getClient` at a
  reliable RPC); `receipt.reference` = channelId (`bytes32`), tx hash only after `session.close()`;
  `tempo.sessionLegacy` deprecated — do not use.

## 3. Landscape — not reinventing; novelty confirmed

No OSS or commercial project does our whole thing. Closest *serving-layer* tools validate the pattern
but we don't adopt them:
- **ROAPI** (Rust, Apache-2.0, file→REST/GraphQL/SQL) and **flAPI** (C++, unclear license, DuckDB→REST+MCP)
  — wrong language; embedding = subprocess/HTTP bridge, against our pure hot path. **Stay TS-native on DuckDB.**
- Datasette (SQLite/Python), PostgREST/Hasura (need a DB), Steampipe (consumes APIs, inverted),
  Cube/Trino/Dremio (BI/cluster) — all wrong fit.
- **Genuinely novel (nobody does):** per-row MPP **session** billing, LLM-authored frozen config,
  baked-in correctness evals as trust signal, self-heal loop, `feePayer` zero-gas agents, demand board.
- Competitor watch: **Zuplo** (x402 per-request charge, Coinbase/Base chain — not Tempo, not session,
  not file-to-Tap). Not close.

## 4. Query-safety + schema inference — small, mostly hand-roll

- **Safe query compile:** the allowlist validation (agent request ⊂ `config.query.{filters,selectable,
  sortable,maxLimit}`) is **ours** in `core/query.ts` regardless. To compile the validated plan →
  parameterized SQL: **hand-roll ~20 lines** in the DuckDB adapter (chosen — keeps `core` dep-light,
  full control), or `kysely` + `kysely-duckdb` (MIT; kysely-duckdb is single-maintainer but thin).
  Never string-concat agent values; values always as `?` params.
- **Schema inference:** `DESCRIBE SELECT * FROM read_parquet|read_csv_auto|read_json_auto('ref') LIMIT 0`
  — one DuckDB call per format, no extra dep. Map DuckDB types → our `FieldType`
  (VARCHAR→string, BIGINT/INTEGER→integer, DOUBLE/DECIMAL→number, BOOLEAN→boolean, TIMESTAMP→timestamp,
  STRUCT/MAP/JSON→json). `hyparquet` (MIT) optional for offline parquet-only peek.

## Decisions (locked)
- Engine: `@duckdb/node-api`, pinned. SQLite fallback behind `SourceAdapter`.
- Query compiler: hand-rolled parameterized builder in the DuckDB adapter; allowlist in `core/query.ts`.
- Schema inference: DuckDB DESCRIBE.
- Billing MVP: **per-query session charge (rows×price), no SSE.** SSE per-row streaming = stretch.
- Store: persistent (redis/upstash) for real deploys; memory for local demo.
- Action: confirm `sse`/streaming session API ships in `mppx@0.7.0` (not just the PR build).

Sources captured in each agent's report (npm/GitHub/docs URLs, maintenance dates).
