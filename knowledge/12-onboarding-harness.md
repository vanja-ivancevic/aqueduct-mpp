# 12 — Onboarding Harness

How a Tap gets built. MVP scope = **static structured files (parquet / CSV / JSON)**, so onboarding is
small and standardized: profile one file → author a declarative config → validate. No web crawling,
no DB sessions, no code execution, no VPS.

## The LLM is inference; the CLI is the harness

The LLM never reaches into the network. The `aqueduct` CLI does all I/O and feeds the model text.

```
aqueduct CLI  (builder's PC)
  1. acquire        CLI does ONE HTTP GET (or reads a local path) for the file   (CLI holds any creds)
  2. profile        CLI samples rows + infers column types (DuckDB DESCRIBE / sample)
  3. prompt LLM     {sample rows, column profile, Tap-config JSON schema}
  4. LLM → config   a JSON object only: schema, query interface, pricing, evals
  5. validate       CLI runs the candidate vs the file (parse, coverage COUNT, goldens); loop on fail
  6. freeze         version the config
```

The model sees **samples as text** and returns **a config**. No live web, no creds, no code.

## What the LLM decides (small, bounded)

Just "parsing + SQL/schema decisions":
- the output **schema** (columns + types) from the profiled file,
- the **query interface** — which fields are filterable (+ operators), selectable, sortable, limits,
- the **pricing** unit + hints, and the **evals** (golden queries, invariants, coverage mode).

That's bounded structured output, not open-ended agentry. The runtime executes it via DuckDB; the LLM
is never in the hot path.

## LLM backend: CLI for dev/demo, API/paid inference for production

Swappable behind the `LlmProvider` seam (CLAUDE.md invariant 6).

| Adapter | Backend | Use | Auth |
|---|---|---|---|
| `claude-cli` | spawn `claude -p --output-format json` | **dev / demo** | subscription |
| `codex-cli` | spawn `codex exec` | **dev / demo** | subscription |
| `openai` | HTTP, OpenAI-compatible `/v1/chat/completions` | **production** | BYO key / base-URL |
| `openrouter-mpp` | same HTTP via mppx-paying fetch | **production, permissionless** | Tempo wallet, no signup |

```ts
interface LlmProvider {
  name: string
  // single-shot, schema-constrained completion — the only thing onboarding needs
  complete(req: { system: string; input: string; schema: JsonSchema }): Promise<Result<unknown, LlmError>>
}
```

**Single-shot is canonical.** Our CLI owns the tool loop (acquire → profile → prompt → validate →
loop); the LLM is used single-shot. Then CLI and HTTP API are interchangeable (`prompt → JSON`) and
demo behaves like prod. The claude-code/codex *agentic* loop is **scratch only** — a plain prod API
has no agent loop, so it won't port; don't build on it.

## DuckDB is needed at onboarding too (not just the host)
Onboarding profiles the file (`DESCRIBE` → schema) and validates the candidate config by running the
*real* query vs a sample (so "validated == what the runtime serves"). So DuckDB runs on the builder's
PC as well as the serving host — but it is **not a manual install**: `@duckdb/node-api` is a dependency
of the `aqueduct` package (prebuilt binaries, no node-gyp), pulled by `npx aqueduct` / `npm i`. Builder
installs aqueduct; DuckDB comes with it. (A pure-JS schema sniff like `hyparquet` could keep the local
install tiny but loses validation fidelity → not MVP.)

## Where it runs
- **MVP onboarding: builder's PC**, CLI backend. Output is a static config; the LLM never touches the
  serving host. **No VPS.**
- **Production:** API/paid-inference backend, callable from anywhere (HTTP); still no VPS for the LLM.

## Roadmap (out of MVP)
Agentic ingestion of *messy* sources (scrape / PDF / live APIs needing auth+pagination) → a hosted
sandbox tool-loop normalizes them into a structured **snapshot** the runtime serves. That reintroduces
a sandbox (security surface) and makes refresh rebuild the snapshot on a schedule. Deliberately out of
MVP — static files need none of it.

## Why this is safe by construction
- LLM holds no credentials; the CLI mediates every external call.
- LLM output is data (a config), not code; validated deterministically before it can be served.
- Runtime executes only a parameterized DuckDB query from the config — no LLM, no codegen, no raw SQL.
