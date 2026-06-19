# Aqueduct

[![license](https://img.shields.io/github/license/vanja-ivancevic/aqueduct-mpp)](./LICENSE)

> **Status:** hackathon-stage, running on the Tempo **Moderato testnet** (test tokens only, no real
> money). **Not yet published to npm** — install from source ([Install](#install)). The `aqueduct` /
> `aqueduct-mcp` commands in this README are the locally-built CLI; run them after the Install step
> (or via `npm run aqueduct -- …`).

**A maintained data dependency for your app — or your agent.** One command turns a Parquet, CSV, or
JSON file into a *Tap*: a live, metered HTTP feed your app consumes in a few lines and **never
maintains**. The
publisher builds the pipeline *once* — fetch, normalize, keep-fresh, serve, meter — and everyone
downstream just queries it, paying per row over [MPP](https://mpp.dev) (the Machine Payments Protocol)
on Tempo: peer-to-peer, settled on-chain, non-custodial (Aqueduct never touches the funds).

Today every team rebuilds, hosts, and *babysits* its own ingestion for the same public data —
duplicated across every app that needs it, breaking whenever the source moves. A Tap collapses that to
**build-the-pipeline-once-for-everyone**: app builders embed a data feature without owning a pipeline,
and agents consume the same feed the same way. DuckDB + MPP are the engine; the **maintained, uniform
feed** is the product.

![Aqueduct system architecture — a dataset is compiled (DuckDB profiling → config assembly → eval gate) into a frozen ValidatedConfig that the runtime serves: agents discover and read the schema for free, then pay per row over an MPP session on Tempo, with parameterized DuckDB queries, a query-hash cache, and non-custodial settlement to the publisher's wallet.](./docs/architecture.png)

```
aqueduct onboard data.parquet --recipient 0xYourPayout       # → data.tap.json
AQUEDUCT_PRIVATE_KEY=0x… aqueduct serve data.tap.json         # → live Tap on :8402
```

No LLM runs when an agent queries. Onboarding profiles the file and writes a frozen, versioned **Tap
config**; the runtime that serves paid requests is pure, deterministic config execution. That's what
keeps it cheap (sub-cent per row) and fast (cached reads < 100 ms).

## The demo — same agent, same task, with vs without Aqueduct

Aqueduct doesn't answer questions; it gives an *agent* a clean data source. `npm run demo` gives one
real research task to two identical `claude` agents and lets them work it:

- **With Aqueduct** — the agent has the Aqueduct MCP tools and queries a live, metered Tap over the
  DOAJ open-access journal corpus (~23k journals), **paying per row over MPP from its own wallet**.
- **On its own** — the same agent, no Aqueduct: told to acquire the data from DOAJ itself.

The task is a real researcher's question — *shortlist diamond-OA (no-APC) Medicine journals with fast,
plagiarism-screened peer review, ranked by output* — which needs the whole corpus to answer faithfully.
The catch: DOAJ put its bulk CSV **and** its API behind Cloudflare in 2025 because AI crawlers
overwhelmed it (traffic spiked **968%** over the prior year in a single day). So a headless agent gets a
`403`. Measured result (`npm run demo`, real run):

| | With Aqueduct | On its own |
|---|---|---|
| answer | **correct** ✓ | **none** ✗ — walled out, wouldn't guess |
| time | 32 s | 17 min |
| agent cost | $0.28 | $2.59 |
| data | one paid MPP query | blocked at the origin (403) |

Walled off, the lone agent spent ~17 minutes and $2.59 probing every route into DOAJ — the bulk CSV,
the API, OAI-PMH, the S3 cache, the Wayback Machine — hit a `403` at each, then stopped, refusing to
fabricate a ranking it couldn't verify. The Aqueduct agent paid a fraction of a cent per row
(0.0114 pathUSD) and answered correctly, while DOAJ's origin was never touched. Nothing is staged (each
agent runs in an isolated dir so neither can read the repo's local copy); re-run it with `npm run demo`.

An agent reaches a Tap two ways: the **`aqueduct` skill** (`skills/aqueduct/`) or the **MCP server**
(the `aqueduct-mcp` binary, see [docs/mcp.md](./docs/mcp.md)) — discover Taps, read a schema for free,
then pay per row. The LLM is always the *client*; it never sits in the serving path.

## Run it yourself (Tempo Moderato testnet)

Everything runs on the public **Tempo Moderato testnet** — test tokens only, no real money (default RPC
`https://rpc.moderato.tempo.xyz`, settlement in testnet pathUSD). Requires Node ≥ 20; the agent demo
also needs the `claude` CLI on your PATH.

```bash
git clone https://github.com/vanja-ivancevic/aqueduct-mpp.git
cd aqueduct-mpp
npm install && npm run build      # build compiles dist/, incl. the MCP server (dist/mcp.js)
npm run demo                      # onboard a CSV → serve a Tap → race two identical agents on it
```

`npm run demo` needs **no keys** — it generates throwaway wallets and funds them from the public faucet,
so it spends no real money. To drive a Tap by hand instead — `serve` it and query it (see
[Build a Tap](#build-a-tap-you-the-data-publisher) below) — you need a funded wallet. Generate one and
top it up from the faucet:

```bash
export AQUEDUCT_PRIVATE_KEY=$(node -e "import('viem/accounts').then(m=>console.log(m.generatePrivateKey()))")
npm run faucet                    # funds the address derived from AQUEDUCT_PRIVATE_KEY (idempotent)
```

Fund an agent's spending wallet the same way: `AQUEDUCT_AGENT_KEY=0x… npm run faucet`. Buying rows
over MPP needs a wallet-holding client — the MCP server (`aqueduct-mcp`, see
[docs/mcp.md](./docs/mcp.md)) or the `aqueduct` skill; a raw `curl` to a paid `/query` returns `402`.

## Why a Tap, not your own pipeline?

The data is public — so why a Tap instead of fetching it yourself? Two reasons, one per side of the
market.

**For the agent / app:** fetching public data once is easy; *owning* it forever is not — and
increasingly you can't even fetch it. The open databases agents depend on are buckling under AI-crawler
load and shutting their doors: Cloudflare walls, proof-of-work firewalls, rate limits, outages. A Tap
is a maintained, metered side-door — one query, pay per row, always fresh, nothing to host or babysit.

**For the data publisher:** that crawler load is a cost with no revenue. A Tap turns it into a metered,
agent-payable API in one command — the publisher builds the pipeline *once*, the origin is offloaded,
and every paying agent funds the upkeep. The publisher is the reseller: they set the per-row price at
onboard (`--unit-price`) and keep the margin above their hosting cost — the data is free to them, the
*access* is the product. Settlement is agent→publisher on Tempo; Aqueduct is non-custodial and never
touches the funds. (Note the two costs are separate: the agent's own model/compute spend is its own; the
data payment is the publisher's per-row price.) Alchemy for the open-data long tail.

(Honest scope: for a *static* file you fetch once and never refresh, DIY is fine — a Tap earns its keep
on data that's **fresh, walled, normalized, or consumed by many**, where the maintenance and access
never end.)

The demo Tap, `examples/doaj-journals.tap.json`, is a 22,940-journal slice of DOAJ compiled with
`aqueduct onboard`. The container deploy path below bakes that same dataset (`examples/doaj-journals.csv`)
and onboards it deterministically at boot.

## Install

Not yet on npm — install from source:

```bash
git clone https://github.com/vanja-ivancevic/aqueduct-mpp.git
cd aqueduct-mpp
npm install && npm run build
npm link                  # makes the `aqueduct`, `aqueduct-mpp`, `aqueduct-mcp` commands available
```

Requires Node ≥ 20; the DuckDB query engine ships as a prebuilt native dependency. Prefer not to link?
Run any command as `npm run aqueduct -- <args>` (e.g. `npm run aqueduct -- onboard …`) or
`node dist/cli.js <args>`. Once published, `npm i -g aqueduct-mpp` will replace the clone+link step.

## Build a Tap (you, the data publisher)

```bash
# Deterministic — infers the schema and a safe query interface, no model required:
aqueduct onboard examples/doaj-journals.csv \
  --recipient 0xYourPayoutAddress \
  --unit-price 0.0001 \
  --out my-doaj.tap.json

# Optional: layer an LLM pass over it for smarter filters + richer correctness checks:
aqueduct onboard examples/doaj-journals.csv --recipient 0x… --refine --llm claude
```

Onboarding runs an **eval gate** (the source has rows, a sample conforms to the inferred schema,
pinned row-count tripwires hold). A config that fails the gate is never written.

```bash
# Serve it. The server re-runs the eval gate before going live.
export AQUEDUCT_PRIVATE_KEY=0x…   # server wallet — MUST be the same address you passed to --recipient
aqueduct serve my-doaj.tap.json --port 8402
```

The serve wallet has to match the config's `recipient`: it's the MPP channel **payee**, and only the
payee can close a session and settle it. Onboard with `--recipient <serve-wallet-address>` (a cold
payout address that differs from the serving key will fail at session close).

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
aqueduct deploy --target akash --image ghcr.io/you/aqueduct:1.0.0   # → akash.deploy.yaml (long-query ingress)
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

One rule underpins it all: **no LLM ever runs on the paid request path.** Onboarding is the only
compile step; the runtime that answers a paid request is pure, deterministic config execution.

## Status & limits

Working end-to-end on the Tempo Moderato testnet: onboard → serve → agent makes **multiple** paid
requests on one session channel (cumulative vouchers, cache hit on repeats) → `200` + rows + receipt →
a single on-chain settle at close. Ships as a stateless container that runs the same locally and on
Akash ([DEPLOY.md](./DEPLOY.md)). Today's scope is **static structured files** (parquet / CSV / JSON).
Known limits: a single in-process session store (multi-instance deploys need a shared store, on the
roadmap), and volatile/live sources are roadmap. Fully-sponsored agent gas needs a separate sponsor
wallet (`AQUEDUCT_SPONSOR_KEY`); without one, agents self-pay gas.

## Documentation

Reference docs live in [`docs/`](./docs/README.md):

- [HTTP API](./docs/http-api.md) — `/schema`, `GET`/`POST /query`, status codes, the receipt
- [Tap config](./docs/config.md) — the frozen source of truth, field by field
- [Query interface](./docs/query.md) — the agent request shape + why agents never send SQL
- [Pricing & billing](./docs/pricing.md) — `rows × unitPrice` over an MPP session
- [Discovery & consumption](./docs/discovery.md) — find/buy Taps via MPP's registry, the skill, the MCP server
- [MCP server](./docs/mcp.md) — expose discover/schema/query to any MCP agent over stdio (`aqueduct-mcp`)
- [How it works](./docs/how-it-works.html) — a plain-language visual walkthrough of the two processes (open in a browser)
- [Deploy](./DEPLOY.md) — ship a Tap local ↔ Akash

## Links

Docs: https://mpp.dev · MPP repo: https://github.com/tempoxyz/mpp · Spec: https://paymentauth.org

## License

MIT © Vanja Ivancevic — see [LICENSE](./LICENSE).
