# 08 — Architecture: Aqueduct / Tap

> **Aqueduct** — open-source framework that compiles any dataset into a **Tap**: a metered,
> agent-payable, MPP-session-served data feed. *"Build a Tap with Aqueduct; agents pay $0.0001/row
> at the Tap."*

Infra track. The product is the **system that multiplies feeds**, not any single feed — that's what
keeps it infra, not app. Open-source core guarantees the classification: anyone self-hosts; no
chokepoint we own.

**MVP scope (locked).** Sources = **static structured files: parquet / CSV / JSON, served via
DuckDB.** Acquisition = one HTTP GET (or local path) — no scraping, auth, pagination, or codegen, so
the ingestion/sandbox/VPS problem disappears. Agents query via a **constrained interface** (declared
filters/columns → parameterized DuckDB SQL; never raw agent SQL) → a real queryable API, priced per
row. Live APIs, SQL DBs, scraped/messy sources, agentic ingestion = roadmap. The demo wow is the
**loop**, not input breadth: *one command turns any public parquet/CSV into a live, queryable,
agent-payable API — schema + evals auto-written by an LLM, paid per row over MPP on Tempo, self-healing
on schema drift.*

## The big picture

```
                         ┌──────────────── ONBOARD (compile-time, LLM) ────────────────┐
  operator ── prompt ──▶ │ Aqueduct onboarding agent                                    │
  + wallet               │  • fetch dataset sample (URL / SQL / file / scrape)          │
  + dataset ref          │  • LLM (paid over MPP) drafts Tap config (schema-constrained)│
                         │  • validate config vs sampled rows → loop until passes       │
                         │  • freeze + version the config                               │
                         └───────────────────────────┬─────────────────────────────────┘
                                                     ▼  Tap config (deterministic artifact)
                         ┌──────────────── DEPLOY (operator-owned host) ────────────────┐
                         │  ComputeProvider adapter → Akash (USDC, signup-less) | host  │
                         │  emits container + manifest, funds escrow from wallet        │
                         └───────────────────────────┬─────────────────────────────────┘
                                                     ▼  public URL
  agent ──402 / session──▶  ┌──── RUNTIME (hot path, NO LLM) ────┐  ──row──▶ agent
                            │ execute config: fetch→parse→meter   │
                            │ mppx session: stream.charge()/row   │  $0.0001/row, sub-100ms
                            │ cache · refresh-cron · settle batch │  margin → operator wallet
                            └─────────────────────────────────────┘
                         + scheduler: refresh (deterministic cron) · research (periodic LLM → config diff)
                         + discovery(): auto-register Tap on mpp.dev/services + mppscan
```

**Cardinal rule:** LLM only at onboard/research time. **Never in the request hot path.** Runtime is
pure config execution — that's what protects the $0.0001/row, sub-100ms economics.

## Components

| Component | Role | LLM? |
|---|---|---|
| Onboarding agent | dataset → frozen Tap config, self-validated | ✅ MPP-paid |
| **Tap config** ⭐ | the portable, versioned artifact — see schema below | — |
| Runtime | executes config, serves rows over mppx sessions | ❌ never |
| Refresh scheduler | cron: re-pull upstream, re-cache, re-validate vs schema | ❌ |
| **Eval suite** ⭐ | per-Tap correctness tests — gates onboarding + repairs + advertises trust | ❌ runs |
| **Self-heal loop** | detect breakage → LLM proposes config diff → eval-gate → promote/rollback | ✅ MPP-paid |
| Research scheduler | periodic LLM: upstream changed? new data? → proposes config diff | ✅ MPP-paid |
| ComputeProvider adapter | deploy runtime to a host (Akash default) | — |
| LlmProvider adapter | onboarding/research inference | — |

## The Tap config (linchpin)

Everything reproducible flows from a tight, versioned spec. LLM fills it; runtime executes it via
DuckDB. Authoritative shape lives in code: `core/config.ts`. MVP scope = static files (parquet/csv/json).

```jsonc
{
  "version": 1,
  "name": "nyc-311",
  "source": {
    "format": "parquet",                       // parquet | csv | json
    "location": { "via": "url", "ref": "https://…/311.parquet" },  // url | path
    "authEnv": null,                           // env var name for a credential, or null (never inline)
    "contract": {                              // gates the published correctness score
      "determinism": "deterministic", "volatileFields": [], "pagination": "none",
      "identityScope": "global", "freshnessWindow": "24h", "comparison": "exact"
    }
  },
  "schema": [ { "name": "borough", "type": "string", "required": true } ],
  "query": {                                   // constrained interface → parameterized DuckDB SQL
    "filters": [ { "field": "borough", "ops": ["eq", "in"] } ],
    "selectable": "*",                         // "*" | ["col", …]
    "sortable": ["created"],
    "maxLimit": 1000, "defaultLimit": 100
  },
  "pricing": {
    "unit": "row",                             // row | page | query | byte | result-set
    "unitDefinition": "one 311 record",
    "unitPrice": "0.0001", "margin": "0.5",
    "currency": "0x20c0…"                       // pathUSD on Tempo
  },
  "cache": { "key": "queryHash", "ttl": "1h" },
  "evals": {                                   // gates onboarding + repairs; published as score
    "golden": [ { "query": "…", "expect": "…" } ],
    "invariants": [ "…" ],
    "coverage": { "mode": "count" },           // DuckDB COUNT(*) vs returned
    "sourceAgreement": { "sampleSize": 5 },
    "freshnessMaxAge": "24h"
  },
  "heal": { "autonomy": "propose", "canaryPct": 10, "budgetPerFix": "0.50",
            "allowedAutoChanges": "parser-path-only" },
  "mpp": { "intent": "session", "recipient": "0xOPERATOR", "currency": "0x20c0…", "feePayer": true }
}
```

## Onboarding protocol (well-defined LLM contract)

1. Operator gives a dataset reference + (optional) upstream key, in a prompt flow.
2. Aqueduct fetches a **sample**, hands it to the LLM with the **config JSON Schema**.
3. LLM emits a candidate config (schema-constrained output, like a forced tool call).
4. Aqueduct **runs the config against the sample**, checks rows parse + schema holds.
5. Fail → feed errors back to the LLM, loop. Pass → **freeze + version**.
6. Parser execution during validation runs **sandboxed** (Vercel Sandbox) — untrusted codegen.

LLM access (see [03](03-ts-sdk-cheatsheet.md), catalog scan): one OpenAI-compatible interface.
- **Default (permissionless):** pay **OpenRouter over MPP** (`openrouter.mpp.tempo.xyz/v1`) with the
  operator's **same Tempo wallet** the Tap earns into — no LLM signup. Recursive dogfooding.
- **Fallback:** operator pastes own OpenAI-compatible key/base-URL.

## Runtime (deterministic, no LLM)

- mppx `tempo.session` server. **MVP billing = per-query session charge** (`mppx.session({ amount })`
  with `amount = rows × unitPrice` computed per request; one charge, one response, **no SSE**). Per-row
  SSE streaming (`stream.charge()` per yield, requires `sse:true` + an SSE-speaking client) = stretch
  wow. `Store.memory()` for local demo; **persistent `Store` (redis/upstash) for real deploys** (memory
  loses channel state on restart). See `13-research-validation.md`.
- `settlementSchedule` batches vouchers → net on-chain settle (by amount/units/time).
- Cache keyed on query hash → repeat queries serve near-free (margin widens with volume).
- `feePayer` sponsors agent gas → agent needs zero native token, just pays the unit price.
- `discovery()` publishes OpenAPI + `x-payment-info.offers[]`; register on mpp.dev/services + mppscan.

## Self-healing + correctness (trust + maintenance layer)

**One eval suite, three jobs:** gate onboarding · gate every auto-repair · advertise correctness to
consumers. Build evals once at onboarding (LLM proposes, validated against sample), freeze in config.

**Self-heal loop** (compile-time LLM, never hot path):
`detect → diagnose+fix (LLM) → eval-gate → promote | rollback`.
- Detect (runtime, deterministic): parse-failure spike, upstream schema mismatch / 4xx-5xx, empty
  responses, latency drop, canary golden-query failures.
- Fix: LLM gets broken config + fresh sample + error → proposes a **config diff** (bug-fix = config
  patch, not code). Costs MPP, **funded from the Tap's own revenue** → margin must cover upkeep →
  `margin = maintenance budget + profit`. This is the monetary-incentive engine.
- Gate: run eval suite on the candidate; promote only if it passes. Canary `heal.canaryPct` of
  traffic; **auto-rollback to last-good** on regression. `heal.autonomy` = auto / propose / alert.

**Correctness evals** (consumers must depend on a Tap):
- Types: schema conformance · golden queries (pinned answers) · invariants · **source-agreement**
  (re-fetch small random sample direct from upstream, diff vs served) · freshness.
- Continuous: cron + after every repair + sampled on live traffic → **correctness score** + timestamp.
- Published in discovery metadata + `/evals` endpoint → **agents read score before paying**.
- **Trust-minimized**: the Aqueduct **registry runs evals independently** as an oracle (self-reported
  scores = marketing, not trust); anyone can submit a golden-query challenge; (roadmap) anchor
  attestations on-chain via MPP receipts.
- **Refund-backing** (`advanced/refunds`): "pay per row, refunded if provably wrong" → wrong data
  costs the operator → aligns the auto-fixer against shipping bad diffs.

**Incentive loop:** `score ↑ → traffic ↑ → revenue ↑ → affords maintenance → self-heals → score ↑`.
Moat shifts from **data → liveness+correctness**: clones without maintenance decay; auto-healing Taps
survive upstream churn.

**Risks:** bad auto-fix serving wrong data confidently (→ strong evals + canary + rollback + refund
backstop); eval gaming (→ independent/registry verification); cost (→ sample, don't exhaustively
re-verify).

## Where it runs (two runtimes, two places)

| Phase | Location | When | LLM |
|---|---|---|---|
| **Onboarding** (`aqueduct onboard`) | **builder's PC** — their CLI (claude/codex), their keys | once | yes |
| **The Tap** (serves agents) | **a host with a public URL** | 24/7 persistent | never |
| **Heal** (`aqueduct heal`) | builder's PC (`propose`/`alert`) — or the host (`auto`, stretch) | on breakage | yes |

The Tap can't live on the builder's PC in production: agents pay it asynchronously over HTTP, so it
must be online + addressable (laptops sleep / NAT / no public URL). Builder's PC = the *workshop*
(compile config, run heal, deploy). The *host* = where the Tap serves + runs deterministic breakage
detection + scheduled refresh.

- **Demo:** host = **local** (`aqueduct serve`; agent hits localhost or a `cloudflared` tunnel),
  payment on Moderato testnet. No cloud. `ComputeProvider = local`.
- **Prod:** operator-owned server (Akash / VPS / Fluid Compute) via `ComputeProvider`.

Heal model by `heal.autonomy`: `propose`/`alert` (MVP) → host only *detects*, operator runs heal on
their PC; `auto` (stretch) → host self-heals, needs LLM access on the host.

## Adapters (the seams)

- `ComputeProvider`: `deploy(config) → { url }`, `destroy()`. **Akash** adapter = crypto-native,
  signup-less default (USDC escrow, programmatic via 2026 AEP-63/64 SDL). A reliable plain-host
  adapter = demo critical path. Fluence = documented alt. (See research in project memory.)
- `LlmProvider`: `{ baseUrl, fetch }` — fetch is mppx-paying (default) or key-auth (fallback).
- `SourceAdapter`: executes an abstract query plan against a file. **Engine = DuckDB via
  `@duckdb/node-api`** (validated — see `13-research-validation.md`; MIT, prebuilt binaries, HTTP Range
  pushdown). The adapter hand-rolls a ~20-line **parameterized** SQL compiler (values always `?`, never
  concatenated); the allowlist validation stays in `core/query.ts`. **SQLite (`better-sqlite3`) =
  fallback** (costs file→sqlite ETL). Engine lives behind this seam: `core/config.ts` + `core/query.ts`
  emit an abstract plan and never import DuckDB → reversible, one adapter, zero core change. Schema
  inference at onboarding = DuckDB `DESCRIBE SELECT * FROM read_*('ref') LIMIT 0`.

## Economics / incentive

Public data is clonable → no data monopoly. Operator margin survives via: onboard-once/earn-forever
(free data + caching widens margin), long-tail first-mover, freshness/SLA (schedulers), aggregation.
Cold-start fix = **demand board** (agents post wanted datasets → operators onboard against demand).
Edge vs RapidAPI: instant stablecoin settlement, permissionless listing, lower take-rate. `margin`
is operator-set in config; optional small protocol fee funds the OSS/registry.

## Legal posture (operator-owned model)

Per-user, operator-owned Taps push liability onto the operator; Aqueduct (OSS) author ≈ near-zero
liability. If we ever run a hosted convenience gateway: **non-custodial** (P2P settlement, never hold
funds), neutral-conduit terms + operator indemnity, sandboxed parsers, entity + counsel. Hackathon =
non-issue (testnet + disclaimer).

## Demo slice (Polish = survival)

Ship the **whole loop on 1–2 datasets**, not the whole platform:

```
chat (wallet, BYO-key fallback) → onboard 1 dataset live → a Tap config
  → deploy (reliable host for the live path; Akash pre-provisioned to prove crypto-native)
  → agent pays the Tap live ($0.0001/row, session) → explorer shows ~2 txs not 1k
  → one scheduled refresh fires
```

**Stretch "wow" (sequence after base loop works):** break the upstream live (change its schema) →
health loop detects → LLM proposes a config fix → evals gate → promote → correctness score recovers,
all paid over MPP. Self-healing infra on stage — hard for anyone to clone.

Roadmap (slides, not built): research scheduler, demand board, Akash live cold-deploy, aggregation,
hosted gateway, on-chain eval attestations.

## Verify before building

- mppx `tempo.session` server API: confirm `stream.charge()` per-unit + `settlementSchedule` shape
  (`payment-methods/tempo/session.mdx`, `Ws.serve`, `_api/api/sessions/*`).
- OpenRouter-over-MPP is OpenAI-compatible wire + works headless with mppx-paying fetch.
- Akash AEP-63/64 SDK supports headless deploy + wallet-funded escrow (else use fallback host for demo).
- Caching/re-serving upstream public data — licensing/ToS limits.
