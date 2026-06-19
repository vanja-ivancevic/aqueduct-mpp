# Aqueduct — Conclusions

The team's distilled memory of *what we concluded and why*. The full research history (19 docs +
raw dumps) is archived in `archive/knowledge/` (gitignored, local only). This is the forward-looking
summary; `CLAUDE.md` is the operating contract, `README.md` is the live positioning.

## 1. Thesis

**Aqueduct is a maintained data dependency for apps and agents.** One command compiles any dataset
into a **Tap**: a live, metered, agent-payable HTTP feed served via DuckDB, billed per row over MPP
(the Machine Payments Protocol) on Tempo, settled peer-to-peer on-chain.

The publisher builds the ingestion pipeline **once** — fetch, normalize, keep-fresh, serve, meter —
and every consumer reads it in a few lines and **maintains nothing**. The audience is *both*:

- **App builders** embedding a data feature, who don't want to own a pipeline for something that
  isn't their product.
- **Agents** answering a question, which structurally *cannot* host infra and can only buy per call.

Build-the-pipeline-once-for-everyone vs every app building and babysitting its own. That inversion
is the product.

> **Positioning evolution (honest record).** Earlier framings were superseded: "Stripe for data →
> agents" (true but undersold the maintained-feed value) and "beat Claude Code on cost for one
> question" (wrong axis — see §3). The maintained-dependency framing above is the one that survived
> contact with the benchmarks.

## 2. Architecture conclusions

The invariants that held up end-to-end (full contract in `CLAUDE.md`):

- **No LLM in the request hot path.** The LLM runs only at onboarding / refine / heal (compile-time).
  The runtime that answers a paid request is pure, deterministic config execution. This is what
  protects the per-row price and the sub-100ms cached path. Validated live on Tempo testnet.
- **The Tap config is the single source of truth for behavior** — frozen, versioned, portable. All
  extraction / query / pricing logic comes from it, never from code branches.
- **Deterministic core, explicit injected edges.** The query planner + pricing + eval engine are pure
  (`core/`, no vendor imports, no I/O). Upstream fetch, cache, clock, session ledger, settlement are
  named, injected dependencies — the runtime is deterministic *given its declared inputs*, and we
  don't call it pure.
- **DuckDB is the engine** (`@duckdb/node-api`, pinned). It was the only option satisfying native
  parquet/CSV/JSON + full SQL + HTTP-range pushdown + reliable prebuilt binaries at once. Agents never
  send SQL: a constrained query interface (declared filters/columns) compiles to *parameterized*
  DuckDB SQL — values always bound `?`, identifiers only from the config allowlist. This is the
  security perimeter.
- **Adapters at every external seam** — `LlmProvider`, `ComputeProvider`, `SourceAdapter`. Core
  depends on interfaces, never concrete vendors. Swapping claude-CLI→OpenRouter or local→Akash touches
  one adapter and zero core code.
- **Only a `ValidatedConfig` can be served.** The eval gate is the only thing that mints that type;
  un-evaluated configs are a type error. Adversarial review hardened this and the query perimeter
  (closed a latent `SELECT *` leak, clamped offset/limit/IN, namespaced + bounded the cache).

## 3. Strategic conclusions (the hard-won ones)

These are the valuable findings. We kept the caveats honest.

- **For easy-to-fetch static data, DIY is fine — a one-shot single-user fetch vs a Tap is a WASH.**
  We measured it: handed a known parquet URL + "use DuckDB", Claude Code answers in ~2 turns for
  ~$0.11, correctly, even when made to *discover* the URL itself (+$0.03). So **do not pitch "cheaper
  than Claude Code" as the core** — on a lone public-data question, Claude Code is cheap, fast, and
  right, and Aqueduct shouldn't try to beat it. (Crossover is ~2 queries.)

- **The value is build-ONCE-and-maintain, amortized across many consumers, plus the
  freshness/normalization treadmill nobody wants to own.** The LLM forms a query (or onboards) once;
  serving it the 2nd…Nth time is $0 LLM + per-row, deterministic. Answer one query 1,000×: Claude Code
  ≈ $110; a Tap ≈ $0.10 — the gap is entirely in not re-invoking an LLM. Aqueduct is strongest on data
  that's **fresh / updating / normalized / consumed-by-many**, weakest on a static file fetched once.

- **Honest defensibility = ADOPTION / network / standard, NOT technology.** The core is thin: an LLM
  *compiler* (messy file → typed, eval-passed config), a thin *runtime* (DuckDB + constrained query +
  MPP metering), and a *standard* (uniform discovery + query so one skill/MCP consumes any Tap). The
  tech is replicable in a weekend. A sophisticated data vendor who already runs the pipeline won't use
  us — they `npm install mppx` into their existing API. The more capable the builder, the less we add.
  So the bet is: become *the* standard way to publish/consume agent-payable data — the way MCP won,
  not the way an algorithm wins. Precedent for thin-wrapper-wins-on-DX-and-standard: Stripe (API over
  Visa), Vercel (over AWS), Shopify, Twilio, MCP.

- **Who it's actually for:** (1) the **long-tail data owner who is *not* a data company** — has a
  useful CSV/parquet, will never hand-build a query API + payment + rate-limiting + discovery; for
  them Aqueduct is the whole stack in one command. (2) the **agent (demand side)** — standardize query
  + discovery so one skill buys from any Tap; value accrues to the consumer as a network.

- **People demonstrably pay for maintained access to PUBLIC data** — this kills the "but the data is
  public" objection. Precedents: crypto data infra (Alchemy $10.2B, The Graph, Dune $1B, Nansen
  $750M — "don't run your own node/indexer" *is* "don't build your own pipeline"); SerpAPI + the
  ~$1B scraping economy (Bright Data, Apify, Oxylabs) over maximally-public Google results; Bloomberg,
  Plaid (~12k bank integrations). **x402** validates agent-native per-call payments — ~165M agent
  transactions, ~$50M volume by early 2026, backed via the Linux Foundation by Stripe/AWS/Google/
  Shopify/Visa/Mastercard. Same primitive as MPP, becoming real this year.

- **Build-vs-buy drivers (why pay despite cheap code), in order:** #1 maintenance / breakage / silent
  failures (the cron that ships stale data and nobody notices), then anti-bot/access friction,
  normalization + point-in-time canonical values, long-tail breadth (nobody maintains 50 pipelines),
  freshness/SLA. The "FX rate" benchmark miss was the most instructive: Claude fetched a *valid but
  different* USD/JPY; a Tap pins one canonical, sourced, reproducible value — that determinism *is* the
  product a data vendor sells.

- **The novel wager** = stitching two separately-proven halves no one has proven *together*: the
  **long tail** of arbitrary datasets (made economical by LLM-compiled onboarding doing the one-time
  normalization a human data team would otherwise fund per dataset) + **agent-native micropayments**
  (x402 / MPP) as buyer and rail. Incumbents can't chase the long tail (human GTM, $15k/yr minimums);
  it's only reachable when onboarding is ~free and settlement is per-call.

## 4. Demo decisions (tried + rejected, with why)

- **Rejected: a simulated upstream-break "self-healing" demo.** Compelling on paper (break the source
  live → detect → LLM proposes a config diff → evals gate → recover), but it requires *faking* a break
  on stage. We judged that dishonest/unfair and cut it to roadmap. Self-heal remains a real designed
  capability, not a demo prop.

- **Rejected: a 3-Tap discovery+join "cosmic neighborhood" demo.** Too clever and too complex, and
  three unrelated facts (exoplanet + quake + FX) read as *random* rather than as one coherent story.

- **Settled on ONE simple side-by-side demo.** A single deliberately-complex query, **Tap vs
  Claude-from-scratch**, run locally, to show the speed/cost gap honestly — paired with the **theory
  argument** that app builders don't want to maintain pipelines. Measured head-to-head across five
  data types: the Tap data plane is ~1,200–3,200× cheaper (≈1,800× overall) and 8–5,780× faster at
  equal freshness, with $0 LLM in the path. The headline demo is the honest side-by-side
  (`scripts/demo.ts`) + the maintained-dependency theory.

## 5. Scope (MVP)

**Locked: static structured files — parquet / CSV / JSON — served via DuckDB.** Acquisition is one
HTTP GET (or local path): no scraping, auth dances, pagination, or codegen. Agents query through a
**constrained interface** (declared filters/columns → parameterized DuckDB SQL; **never raw agent
SQL**), priced per row. For a static file the source contract is just a *determinism class* + a
*freshness window*; richer terms land with volatile sources.

**Roadmap (designed, not built):** volatile/live APIs, SQL DBs, scraped/messy sources, agentic
ingestion; per-row SSE streaming (prototyped then cut from MVP — needs mppx SSE-metering fixes upstream);
self-heal loop on eval drift; persistent/shared session Store (in-memory today → single-process only);
hosted Akash cold-deploy; research scheduler; demand board; on-chain eval attestations.

## 6. Pointer

Full research history — landscape scan, protocol notes, correctness design, validation passes,
adversarial reviews, the cost benchmarks, and market-precedent ammunition — is archived in
`archive/knowledge/` (00-index → 18-market-precedent). It is **gitignored / local only**, kept out of
the published repo. This file is the distilled conclusion; reach for the archive when you need the
underlying evidence or the *why* behind a specific decision.
