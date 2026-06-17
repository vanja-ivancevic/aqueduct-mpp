ADVERSARIAL REVIEW — Aqueduct (MPP/Tempo hackathon, infra track)

You are a hostile senior reviewer. Goal: find real defects, not praise. Be specific and cite
file:line. Rank findings by severity (blocker / major / minor). If you find nothing in an area, say so.

## What Aqueduct is
Compiles a static dataset (parquet/csv/json) into a "Tap": a metered, agent-payable HTTP data feed,
billed per-row over MPP sessions on the Tempo testnet (chainId 42431, pathUSD). OSS framework.

Architecture law is in CLAUDE.md. Key invariants:
1. NO LLM in the request hot path (LLM only at onboarding/compile-time).
2. The frozen Tap config (`*.tap.json`) is the single source of truth for behavior.
3. Deterministic core (pure extractor) + explicit injected edges. Runtime is NOT pure but deterministic
   given declared inputs.
4. Correctness = fidelity to the upstream source file.
5. Non-custodial — we never hold funds; settlement is agent↔operator on Tempo.
6. Adapters at every external seam (LlmProvider, ComputeProvider, SourceAdapter).

## Layout
- core/        pure: config.ts (zod schema + ValidatedConfig brand), query.ts (planQuery = the security
              perimeter; agents never send SQL), evals.ts, pricing.ts (BigInt money), onboard.ts (LLM
              path, optional), defaults.ts (deterministic config gen, the default).
- adapters/    source/duckdb.ts (DuckDB SourceAdapter), llm/cli.ts (claude/codex CLI LlmProvider).
- runtime/     server.ts (Hono; the hot path), cache.ts (query-result TTL cache).
- cli/         index.ts (aqueduct onboard/serve).
- scripts/     pay-smoke.ts (live testnet payment proof).

## Request model
- GET  /schema              free discovery.
- GET  /query?q=<base64url JSON agent-request>   PAID content path.
- POST /query               MPP session channel lifecycle (open/voucher/top-up/close).
Server uses mppx `tempo({account,currency,feePayer,testnet,getClient})` (charge+session intents).
Billing: amount = returnedRows × unitPrice (exact BigInt). Zero rows = free. Cache hit serves without
DuckDB or the billing COUNT.

## Review these areas adversarially — find the holes
1. SECURITY PERIMETER (core/query.ts + adapters/source/duckdb.ts): can an agent inject SQL, read
   undeclared columns, bypass the filter/op allowlist, DoS via huge scans, or abuse the base64url `q`
   param? Is parameterization actually airtight (IN-lists, LIKE, timestamps)?
2. BILLING/PAYMENT (runtime/server.ts): can an agent get rows without paying, be over/undercharged,
   replay a voucher, or exploit the GET-content / POST-management split? Is the cache-hit billing
   path correct (count vs returned rows, offset/limit clamping)? Is the 402→pay→200 gate sound?
3. CACHE CORRECTNESS (runtime/cache.ts): key collisions, stale rows, TTL bugs, serving wrong data
   across different agent requests, unbounded memory growth.
4. HOT-PATH INVARIANT: any LLM/upstream/config-mutation sneaking into the request path? Any O(dataset)
   work per request?
5. EVAL GATE (core/evals.ts): can a bad config pass evals? Are coverage/schema/golden/invariants
   actually meaningful, or trivially satisfiable? Does the deterministic generator (core/defaults.ts)
   produce configs that pass evals vacuously?
6. DETERMINISM / TYPES (core/config.ts, core/onboard.ts): the config was just trimmed — is anything
   now under-specified? Is the ValidatedConfig brand actually unforgeable? Money-as-string handling.
7. NON-CUSTODIAL / SETTLEMENT: any path where we hold funds or create liability?
8. GENERAL: error handling, resource leaks (DuckDB connections), failure modes, anything that breaks
   under load or adversarial input.

Output: a ranked findings list (blocker/major/minor), each with file:line, the concrete exploit or
failure, and a one-line fix. Then 3 highest-priority things to fix before a hackathon demo.
