# Aqueduct

**Compile any dataset into a Tap: a metered, agent-payable data feed.** Point Aqueduct at a
parquet / CSV / JSON file and it produces a *Tap* — an HTTP service where AI agents pay per row over
[MPP](https://mpp.dev) (the Machine Payments Protocol) on Tempo, via off-chain session vouchers
settled on-chain.

```
npx aqueduct-mpp onboard data.parquet --recipient 0xYourPayout   # → data.tap.json
AQUEDUCT_PRIVATE_KEY=0x… npx aqueduct-mpp serve data.tap.json     # → live Tap on :8402
```

No LLM runs when an agent queries. Onboarding profiles the file and writes a frozen, versioned **Tap
config**; the runtime that serves paid requests is pure, deterministic config execution. That's what
keeps it cheap (sub-cent per row) and fast (cached reads < 100 ms).

## Watch it run

A terminal recording of an LLM answering a natural-language question by buying *only the rows it
needs* from a live Tap of NASA's exoplanet archive (~1,500 planets) — discover terms (free) → form a
query → pay per row over MPP → settle on-chain → answer:

```
asciinema play docs/aqueduct-ask.cast      # or: asciinema upload docs/aqueduct-ask.cast
```

Reproduce it live (Tempo testnet): `npx tsx scripts/ask.ts "your question"`. The agent uses the
**`aqueduct` skill** (`skills/aqueduct/`) — a `SKILL.md` plus a paid-query tool — so any Claude Code
agent can discover, query, and pay a Tap. The LLM is the *client*; it never sits in the serving path.

## Install

```bash
npm i -g aqueduct-mpp     # or use npx aqueduct-mpp …
```

Requires Node ≥ 20. The DuckDB query engine ships as a prebuilt native dependency.

## Build a Tap (you, the data publisher)

```bash
# Deterministic — infers the schema and a safe query interface, no model required:
npx aqueduct-mpp onboard ./cities.parquet \
  --recipient 0xYourPayoutAddress \
  --unit-price 0.0001 \
  --out cities.tap.json

# Optional: layer an LLM pass over it for smarter filters + richer correctness checks:
npx aqueduct-mpp onboard ./cities.parquet --recipient 0x… --refine --llm claude
```

Onboarding runs an **eval gate** (the source has rows, a sample conforms to the inferred schema,
pinned row-count tripwires hold). A config that fails the gate is never written.

```bash
# Serve it. The server re-runs the eval gate before going live.
export AQUEDUCT_PRIVATE_KEY=0x…   # server wallet — receives settlement
npx aqueduct-mpp serve cities.tap.json --port 8402
```

Endpoints:

| Route | Cost | Purpose |
|---|---|---|
| `GET /schema` | free | discovery — columns, filters, price, token |
| `GET /query?q=<base64url JSON>` | paid | the data (one MPP session voucher per query) |
| `POST /query` | — | MPP session channel lifecycle (open / top-up / close) |

The agent request rides in `q` as base64url-encoded JSON: `{ select?, filters?, sort?, limit?, offset? }`,
constrained to exactly the fields/operators the config declares. Agents never send SQL.

### Ship it (local ↔ Akash)

A Tap runs as **one stateless container** — same image on your laptop and on [Akash](https://akash.network).
It onboards the baked dataset deterministically at boot (no LLM), gates it, then serves. `aqueduct deploy`
renders the orchestrator manifest:

```bash
docker build -t ghcr.io/you/aqueduct:1.0.0 .

aqueduct deploy --target local --image ghcr.io/you/aqueduct:1.0.0   # → docker-compose.yml
aqueduct deploy --target akash --image ghcr.io/you/aqueduct:1.0.0   # → akash.deploy.yaml (SSE-ready ingress)
```

Secrets are never baked — local interpolates them from your env, Akash takes them as manifest values you
fill in. Full guide: **[DEPLOY.md](./DEPLOY.md)**.

## Consume a Tap (the agent)

```ts
import { tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const session = tempo.session.manager({ account, getClient, maxDeposit: "1" });
const q = Buffer.from(JSON.stringify({ filters: [{ field: "country", op: "eq", value: "JP" }], limit: 50 }))
  .toString("base64url");

const res = await session.fetch(`${tap}/query?q=${q}`);  // 402 → session voucher → 200
const { rows, count, amount } = await res.json();         // billed `count × unitPrice`
await session.close();                                    // settle the cumulative voucher on-chain
```

First request gets a `402` challenge; the session manager opens a channel, signs a voucher, and
retries to `200`. Pricing is `returnedRows × unitPrice` (zero-row queries are free). Settlement is
peer-to-peer agent↔publisher on Tempo — **Aqueduct is non-custodial and never touches funds.**

## Environment

| Var | Used by | Meaning |
|---|---|---|
| `AQUEDUCT_PRIVATE_KEY` | `serve` | server wallet key (receives settlement) |
| `AQUEDUCT_SECRET` | `serve` | MPP challenge-signing secret. Random per process if unset; set it to keep it stable across restarts / instances |
| `AQUEDUCT_SPONSOR_KEY` | `serve` | optional — a **separate** funded wallet that sponsors agents' on-chain gas (incl. settlement). Must differ from the settlement wallet. Omit → agents self-pay gas |
| `AQUEDUCT_RPC_URL` | `serve` | Tempo RPC (default: Moderato testnet) |

## Programmatic API

```ts
import { deriveConfig, createTapServer, DuckDbEngine, validate } from "aqueduct-mpp";
```

Exposes the same pieces the CLI composes: `deriveConfig` / `onboard` (build a config), `validate`
(the eval gate → a `ValidatedConfig`, the only servable type), `createTapServer` (the runtime),
and the `DuckDbEngine` adapter.

## How it's built

- **`core/`** — pure logic, no I/O, no vendor SDKs: the config schema, the query planner (the security
  perimeter — declared filters/columns → an abstract plan, never raw SQL), the eval engine, BigInt
  pricing.
- **`adapters/`** — the external seams: `source/duckdb` (reads parquet/CSV/JSON), `llm/cli`
  (claude/codex for the optional refine pass), `compute/{local,akash}` (renders the deploy manifest).
- **`runtime/`** — the hot path: a Hono server that executes a config behind an MPP session charge,
  plus a TTL result cache.

See `CLAUDE.md` for the full architecture and its invariants.

## Status & limits

Working end-to-end on the Tempo Moderato testnet: onboard → serve → agent makes **multiple** paid
requests on one session channel (cumulative vouchers, cache hit on repeats) → `200` + rows + receipt →
a single on-chain settle at close. Ships as a stateless container that runs the same locally and on
Akash ([DEPLOY.md](./DEPLOY.md)). Today's scope is **static structured files** (parquet / CSV / JSON).
Known limits: a single in-process session store (multi-instance deploys need a shared store, on the
roadmap), and volatile/live sources are roadmap. Per-row SSE streaming works end-to-end but is **opt-in**
(`--stream`) — it needs two mppx SSE-metering fixes shipped as patches, and a mid-stream-disconnect close
edge remains; see [docs/streaming.md](./docs/streaming.md). Fully-sponsored agent gas needs a separate
sponsor wallet (`AQUEDUCT_SPONSOR_KEY`); without one, agents self-pay gas.

## Documentation

Reference docs live in [`docs/`](./docs/README.md):

- [HTTP API](./docs/http-api.md) — `/schema`, `GET`/`POST /query`, status codes, the receipt
- [Tap config](./docs/config.md) — the frozen source of truth, field by field
- [Query interface](./docs/query.md) — the agent request shape + why agents never send SQL
- [Pricing & billing](./docs/pricing.md) — `rows × unitPrice` over an MPP session
- [Discovery & consumption](./docs/discovery.md) — find/buy Taps via MPP's registry, the skill, the MCP server
- [Streaming](./docs/streaming.md) — per-row metered SSE, settled on-chain (opt-in `--stream`)
- [Deploy](./DEPLOY.md) — ship a Tap local ↔ Akash · [Demo](./DEMO.md) — the live LLM-buys-data run

Design docs (the *why*) are in [`knowledge/`](./knowledge/00-index.md).

## Links

Docs: https://mpp.dev · MPP repo: https://github.com/tempoxyz/mpp · Spec: https://paymentauth.org
