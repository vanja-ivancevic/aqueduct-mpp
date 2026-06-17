# 15 — 3-way adversarial review + fixes (2026-06-17)

Reviewed by: our own architect agent (Opus), **codex** CLI, **gemini-3-pro-preview**. Shared brief:
`knowledge/raw/review-prompt.md`. The three were largely complementary; one direct disagreement
(below). Everything verified against source before fixing.

## The disagreement: `SELECT *` leak
Codex + Gemini: **BLOCKER**. Our architect: "sound, never widens to `*` unless everything selectable."
Resolution — both half-right: `planQuery` emitted `"*"` when `selectable === "*"`, and `compilePlan`
turned that into raw SQL `SELECT *` = **all physical file columns**. Deterministic onboarding sets
`schema = all physical columns` (no leak there), but the instant a builder/LLM omits a column from
`schema` while leaving `selectable:"*"`, that column leaks. Real latent blocker. **Fixed.**

## Fixed (with regression tests — suite 61 → 70)
| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | `SELECT *` leaks undeclared physical columns | `planQuery` resolves `*` → declared schema names; `QueryPlan.columns` is always `string[]`; compiler never emits `*` | query: `*` expands |
| 2 | `offset` unclamped + inlined → invalid SQL / full scan | zod `.max(MAX_SAFE_INTEGER)` rejects absurd; planner clamps to `MAX_OFFSET` (1e8) | query: clamp + reject |
| 3 | No caps on `q`/filters/`IN`/select/sort/value-len | zod `.max()` on arrays; `IN` ≤ 100; value ≤ 512 chars | query: in-cap, len, filters-cap |
| 4 | Bad timestamp string → unpaid 500 at CAST | reject unparseable timestamps in `planQuery` (400, not 500) | query: timestamp reject |
| 5 | Engine throws after charge / on bad input → 500 w/ stack | `try/catch` around `countMatching` + `query` → 502, never a stack leak | (server) |
| 6 | `unitPrice:"0"` → amount-0 session breaks billing | `checkSemantics` requires `unitPrice > 0` | config: zero price |
| 7 | `secretKey:"dev"` hardcoded in serve | CLI generates a per-process secret (`AQUEDUCT_SECRET` or random); realm = tap name | (cli) |
| 8 | Zero-row query never cached → free re-COUNT DoS | cache the empty result before returning | (server) |
| 9 | Cache unbounded (OOM) | `memoryCache` LRU bound (`DEFAULT_MAX_ENTRIES` 10k) | cache: LRU evict |
| 10 | Cache key not Tap-scoped → cross-dataset collision | `cacheKey(plan, namespace)`; server namespaces by `name:source.ref` | cache: namespace |
| 11 | Cache key permutable by JSON key order | predicates/order flattened to tuples | (cache) |
| 12 | `ValidatedConfig` brand bypassable | `createTapServer` now requires `ValidatedConfig` (only the eval gate mints it) | (server.test validates) |
| 13 | Deterministic evals vacuous (no golden) | `deriveConfig` synthesizes a total-rows golden tripwire | defaults: 3/3 evals |
| 14 | No DuckDB `close()` (leak in short commands) | `DuckDbEngine.close()`; CLI calls it after onboarding | — |
| 15 | URL sources need httpfs | best-effort `INSTALL/LOAD httpfs` at engine create | — |

## Confirmed sound (no change)
- **No SQL injection**: values are bound `?` params; identifiers come only from config allowlist and
  are defensively quoted (`quotedIdentifier`/`quotedString` verified to escape).
- **Billing parity**: cache-hit (`rows.length`) and cache-miss (`countMatching` = matched−offset
  clamped to limit) bill the same cardinality; 402-before-serve gate correctly ordered.
- **Pricing math**: exact BigInt, money-as-string.
- **Non-custodial**: no fund custody; recipient is operator-side; a known secretKey can't forge an
  agent-signed voucher (the on-chain escrow is the real guard).

## Likely false positives (verified against live behavior)
- "POST management overcharges 1 unit" — live smoke shows management POST → **204**, agent cumulative
  unchanged; `withReceipt()` returns the management response without applying the content charge.
- "Cache key permutable by request order" — `planQuery` normalizes predicates to fixed
  `{field,op,value}`, so the *plan* is canonical regardless of request key order (hardened to tuples
  anyway).

## Robustness pass (second round)
- **DuckDB single-connection concurrency**: probed 50 concurrent distinct queries → all correct;
  node-api serializes internally, no pool needed. Sound, no change.
- **Unbounded `q`**: capped raw `?q=` at 256 KB before decode (`MAX_Q_CHARS`) + tests.
- **CLI `serve` missing/garbled config**: clean error, not a stack.
- **Lint debt cleared**: test `as any` → one ignored alias; `.firecrawl`/`dist` biome-ignored;
  `package.json` formatted. Whole repo lint-clean.

## The two mppx blockers — ROOT-CAUSED + FIXED (deep-read of vendored mppx src)
- **Sponsored settle** (`"fee payer cannot resolve to sender"`): Tempo rejects a sponsored tx whose
  fee-payer == sender. `feePayer:true` makes the server both. Open/top-up are client-signed (sender =
  agent ≠ sponsor) so sponsorship works; close/settle is server-signed, so sender == sponsor under
  `true`. **Fix:** pass a DISTINCT sponsor `Account` (`opts.sponsorAccount` / `AQUEDUCT_SPONSOR_KEY`),
  never `true`. Without one, agents self-pay gas (works today).
- **Multi-request top-up 402**: the top-up is a client-funded on-chain deposit the server can't
  synthesize; mppx masks the verify failure as 402 and the client's `postTopUp` hard-throws on non-2xx
  (no retry, unlike close). **Fix:** advertise a `suggestedDeposit` (default `"0.10"`) covering the
  whole session, so the channel opens big and `topUpIfNeeded` short-circuits — no top-up POST fires.

**Result — multi-call now works LIVE**: `pay-smoke` makes TWO paid requests on one channel
(cumulative 300 → 600, **paid #2 served from cache, `cached:true`**), no top-up, then a single on-chain
settle at close (`204`, settlement reference). The earlier "single voucher only" limit is gone.

## Still roadmap
- **Persistent/shared voucher Store**: combined `tempo()` doesn't expose store injection in its type;
  in-memory default is single-process-safe; multi-instance needs a durable shared store.
- **True prepay-before-COUNT**: a cache-miss still runs one bounded `COUNT` (bounded by the caps +
  zero-row caching).
- Minor: `ttl:"0s"` disables cache; `selectable:"*"` default exposes all declared columns.
