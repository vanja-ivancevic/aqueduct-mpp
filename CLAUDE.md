# Aqueduct — Theory of the Codebase

Aqueduct compiles any dataset into a **Tap**: a metered, agent-payable, MPP-session-served data feed.
This file is the operating contract for all code here. Design docs live in `knowledge/` (start at
`knowledge/00-index.md`; architecture = `08`, correctness = `10`, testnet = `09`).

## North star

**Clarity beats cleverness. Small beats clever-small. Boring beats novel.**
We ship infra others depend on, under hackathon time pressure. A reviewer should understand any file
in one read. If a choice trades legibility for a micro-optimization, legibility wins — *except* on the
hot path (see below), where both must hold.

Optimize, in order: **correctness → legibility → hot-path speed → everything else.**

**Scope (MVP).** **Static structured files — parquet / CSV / JSON — served via DuckDB.** Acquisition
is a single HTTP GET (or local path); no scraping, auth dances, pagination, or codegen. Agents query
through a **constrained query interface** (declared filters/columns → parameterized DuckDB SQL, never
raw agent SQL). Live APIs, SQL databases, scraped/PDF/JS-rendered sources, and agentic ingestion of
messy data are **out of MVP** — roadmap. A Tap may only advertise a correctness score if it carries a
**source contract**. For static files that contract is just a *determinism class* and a *freshness
window*; the richer terms (volatility fields, identity scope, comparison strategy) land with volatile
sources, not before — the config declares only what the runtime actually honors.

## Architectural invariants — never break these

These are laws, not preferences. A change that violates one is wrong even if it "works."

1. **No LLM in the request hot path.** LLMs run only at onboarding / repair / research (compile-time).
   The runtime that answers a paid request is pure, deterministic config execution. This is what
   protects $0.0001/row and sub-100ms. Breaking it breaks the product.
2. **The Tap config is the single source of truth for *behavior*.** Frozen, versioned, portable. All
   extraction / normalization / pricing logic comes from it — never from code branches or side config.
   (The runtime still holds operational *state* — cache, session ledger, eval scores, last-good config.
   That's allowed and expected; see invariant 3. Config governs behavior; state is explicit and named.)
3. **Deterministic core, explicit edges — the runtime is NOT pure, and we don't call it pure.** The
   *extractor* is pure: `(config, rawUpstreamResponse, request) → rows`, same inputs → same rows, no
   I/O, no clock, no randomness. Everything else — upstream fetch, cache, clock/TTL, session
   accounting, settlement — is an **explicit, injected, named** dependency with recorded provenance,
   not hidden state. The runtime is deterministic *given its declared external inputs*. Name your
   state: `config` (immutable) · `ledger` (sessions/vouchers) · `cache` · `eval` · `deploy`.
4. **Correctness is fidelity to upstream.** The upstream provider is the oracle. Evals anchor on
   source-agreement. We never claim absolute truth; we claim faithful, complete, fresh delivery.
5. **Non-custodial.** We never hold user funds. Settlement is agent↔operator, peer-to-peer on Tempo.
6. **Adapters at every external seam.** The core depends on interfaces, never concrete vendors:
   `LlmProvider`, `ComputeProvider`, `SourceAdapter`. Swapping Claude-CLI→OpenRouter, or local→Akash,
   touches one adapter and zero core code.

## Structure & boundaries

```
core/        pure logic: config types, query planner, eval engine. NO vendor imports, NO I/O.
adapters/    the seams: llm/ (claude-cli, codex-cli, openai, openrouter-mpp), compute/ (local, akash), source/ (parquet, csv, json — via DuckDB)
onboard/     compile-time: profile file → config (LLM), validation loop
runtime/     the hot path: mppx tempo.session server; executes a config via DuckDB
evals/       the suite + harness (shared by onboard, repair, continuous)
cli/         npx aqueduct …  (onboard, serve, eval)
```

- **`core/` is sacred**: pure, deterministic, dependency-light, no vendor/SDK imports, no I/O. If it
  needs the outside world, it takes an injected interface. `core/` must be unit-testable with no mocks
  of network/clock/LLM beyond a trivial fake.
- **Dependencies point inward.** `runtime`/`onboard`/`cli` depend on `core` + `adapters`. `core`
  depends on nothing of ours but its own types. No cycles.
- **One concept per file.** A file does one thing; its name says what. Prefer many small files over a
  few god-files.

## The hot path (performance law)

The code path from "paid request arrives" to "row returned" is the *only* place we hand-optimize.

- **Two SLOs, not one.** **Cache hit: <100ms, deterministic** — voucher verify (microseconds) +
  pure extractor + serve, no upstream. **Cache miss: upstream-bound** — latency is the source's, not
  ours; prefer prefetch / async refresh so live misses are rare. Never advertise one data-plane-wide
  `<100ms` number — that's only the cached path.
- Allowed: signature verify, cache read, deterministic parse, voucher accounting.
- **Forbidden on the hot path:** LLM calls, schema inference, config mutation, unbounded upstream
  fetches, allocations in loops you can hoist, anything `O(n)` in total dataset size.
- Caching is hot-path infrastructure: key on query hash; a hit serves without touching upstream. This
  is also where margin widens — treat cache correctness as production code.
- Everything expensive (LLM, validation, large fetch, settlement broadcast) happens **off** the hot
  path: at onboarding, on a schedule, or batched (mppx `settlementSchedule`).

## Simplicity rules

- **No premature abstraction.** Write the concrete thing twice before extracting the third. The only
  abstractions we commit to upfront are the three adapter interfaces (they're invariants).
- **Functions over classes.** Reach for a class only for genuine stateful lifecycle (e.g. a session
  manager). Pure transforms are functions.
- **No framework we don't need.** Runtime = mppx + a Fetch-native router (hono) + viem. That's the
  budget. Adding a dependency requires a one-line justification in the PR.
- **Make illegal states unrepresentable.** Encode invariants in types: a config that isn't validated
  has a different type than one that is; only a `ValidatedConfig` can be served.
- **Errors are values, localized.** Eval/extraction failures return structured, located results
  (what broke, where) — the repair loop consumes them. Don't throw away diagnostic info.

## Naming & style

- TypeScript, strict. Biome for lint+format (matches upstream mppx). vitest for tests/evals.
- Names say intent, not type: `extractRows`, not `doParse`; `ValidatedConfig`, not `ConfigObj`.
- Match the surrounding code's idiom. No clever one-liners that need a comment to decode — rewrite
  legibly instead. Comments explain *why*, never *what*.
- Keep public surface small. Export the minimum. Internal helpers stay internal.

## Evals & correctness as first-class

- The eval suite (`evals/`) is **product code, not test code** — it gates onboarding, gates repairs,
  and produces the published correctness score. Treat it with production rigor.
- `source-agreement`, `coverage`, `schema`, `invariants`, `freshness` per `knowledge/10`.
- Every Tap ships with evals or it doesn't ship. No silently-trusted feeds.
- Our own dev tests follow the same spirit: prove the behavior on real data, including the failure
  case (corrupt the config → evals must fail and localize).

## Dependencies

Minimal, justified, pinned. Default set: `mppx`, `viem`, `hono`, `zod` (config schema + validation),
`duckdb` (the query engine for parquet/CSV/JSON — earns its place; replaces hand-rolled readers + SQL).
LLM access via adapters (claude/codex CLI for dev; OpenAI-compatible / openrouter-mpp for prod) — no
provider SDK in core. Anything else: justify in the PR.

## Definition of done (per unit of work)

1. Respects every invariant above.
2. `core/` changes are pure + unit-tested with no heavy mocks.
3. Hot-path changes stay within budget (no LLM, no unneeded I/O).
4. New Tap behavior has evals.
5. A new reader understands the file without you explaining it.
6. **Docs track the change.** Any change to behavior, CLI, config, API, or deploy updates the
   relevant `docs/` page, `README.md`, and `DEPLOY.md`/`DEMO.md` in the *same* unit of work — never
   a follow-up. Stale docs are a defect. (Design rationale lives in `knowledge/`; user-facing
   reference lives in `docs/` + the root markdown.)

## Anti-patterns (reject on sight)

- LLM or upstream fetch sneaking into the hot path.
- Config read from anywhere but the frozen artifact; runtime holding hidden state.
- Vendor SDK imported into `core/`.
- A 400-line file doing five things.
- Abstraction with one implementation and no second caller.
- "Temporary" code that bypasses evals to ship a feed.
