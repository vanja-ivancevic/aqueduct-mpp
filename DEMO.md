# Aqueduct — Live Demo Runbook

> A raw CSV becomes a metered, agent-payable data feed — paid per row over MPP sessions, settled
> on-chain on Tempo testnet. One command, ~60 seconds, real value moves.

## TL;DR — run it

```bash
npm install
npx tsx scripts/demo.ts            # uses examples/cities.csv
npx tsx scripts/demo.ts my.parquet # or any parquet / csv / json
```

Needs only network access (it funds throwaway wallets from the public Tempo faucet). No keys, no
config, no setup.

## What the audience sees

The script narrates four steps. Each line on screen maps to a claim in the pitch:

```
 1  COMPILE  — profile the file into a Tap config (deterministic, NO LLM)
              schema + query interface + price derived from the data itself; evals 3/3 pass
 2  SERVE    — start the Tap: free GET /schema, paid GET /query over MPP sessions
 3  AGENT    — an agent discovers terms for free, then pays per row on one session channel
              #1  cache miss → 200, rows=2, paid 0.0002 pathUSD
              #2  same query → cache HIT, fresh voucher, cumulative grows
 4  SETTLE   — close the channel; the cumulative voucher settles in ONE on-chain tx
              prints the Tempo explorer link to the settlement transaction
```

The explorer link at the end is the proof: the agent paid the operator, peer-to-peer, on-chain.

## What each step proves (the talking points)

| Step | On screen | The claim it backs |
|------|-----------|--------------------|
| **Compile** | `evals 3/3 passed (score 1.00)` | Any dataset → a working priced feed with **zero LLM** and zero hand-config. The query interface and golden tripwire are derived from the schema. |
| **Serve** | `GET /schema (free)` | Agents discover terms (schema + price) before paying — the 402 "challenge" half of MPP. |
| **Agent #1** | `cache miss → paid 0.0002` | Pay **per row** (2 rows × 0.0001), priced *before* the charge, gated by a Tempo session voucher. |
| **Agent #2** | `cache HIT, cumulative=400` | The hot path: a repeat query serves from cache (no upstream, no DuckDB) yet still bills — this is the `<100ms` deterministic path and where margin lives. |
| **Settle** | explorer tx link | **Non-custodial**: thousands of sub-cent vouchers settle as a single agent→operator transaction. We never touch funds. |

## The architecture in one glance

```
  raw file ──COMPILE (deterministic, no LLM)──▶ Tap config ──serve──▶ ┌─────────────────┐
  (csv/parquet/json)                            (frozen, validated)    │   Tap server    │
                                                                       │  GET /schema    │ free
   agent ──MPP session──────────────────────────────────────────────▶ │  GET /query?q=  │ paid
        voucher per request, settle once on-chain (Tempo)              └────────┬────────┘
                                                                                │
                                  planQuery (security perimeter) ──▶ DuckDB ──▶ rows
                                  cache hit → no upstream, deterministic, <100ms
```

- **No LLM in the request path.** The LLM (optional, `--refine`) runs only at compile time. The
  runtime that answers a paid request is pure config execution + payment.
- **The config is the single source of truth.** Frozen, versioned, validated by evals before it can
  be served (`ValidatedConfig` — un-evaluated configs are a *type error*).
- **Agents never send SQL.** A constrained query interface (declared filters/columns/sorts) compiles
  to parameterized DuckDB SQL. Values stay data; they never become SQL.

## If you want to drive it by hand

```bash
# 1. compile a file into a Tap config (deterministic). Writes cities.tap.json.
npx aqueduct onboard examples/cities.csv --recipient 0xYourPayoutAddress

# 2. serve it — the server wallet (receives settlement) comes from the env
export AQUEDUCT_PRIVATE_KEY=0xYourServerWalletKey
export AQUEDUCT_SECRET=$(openssl rand -hex 32)     # stable MPP challenge secret
npx aqueduct serve cities.tap.json                 # listens on :8402 (override with --port)

# 3. discover terms (free)
curl localhost:8402/schema

# 4. a paid query is GET /query?q=<base64url JSON> — the agent's MPP session manager handles
#    the 402 → voucher → receipt automatically (see scripts/pay-smoke.ts for the client side).
```

> The server wallet must be funded with pathUSD on Tempo testnet to settle. To sponsor agents' gas
> instead, set `AQUEDUCT_SPONSOR_KEY` to a *separate* funded wallet (it must differ from the server
> wallet — Tempo rejects a sponsored tx whose fee-payer equals the sender).

## Troubleshooting

- **"timed out funding …"** — the public faucet was slow/unreachable. Re-run; it's idempotent.
- **Gas / "fee payer" errors** — the demo has the agent self-pay gas (the reliable path). Sponsored
  gas needs a *distinct* funded sponsor wallet (`AQUEDUCT_SPONSOR_KEY`); a server can't sponsor its
  own settlement (Tempo rejects fee-payer == sender).
- **Port 8500 busy** — the demo's port is hard-coded; free it or kill the stale process.

## What's real vs. scoped for the hackathon

- **Real:** deterministic compile, the constrained query path, the cache, per-row pricing, live MPP
  sessions, on-chain settlement — all demonstrated end-to-end above.
- **MVP scope:** static structured files (parquet/csv/json) via DuckDB, acquired by a single GET or
  local path. Live APIs, SQL/scraped sources, and agentic ingestion of messy data are roadmap.
