# 14 — Live testnet payment proof (MVP vertical, end to end)

Status: **PROVEN on Tempo Moderato testnet, 2026-06-17.** The full Aqueduct vertical runs live —
not mocked.

## What was proven

```
aqueduct onboard <file>   → DETERMINISTIC config (schema → query iface + evals) → eval gate → <name>.tap.json
aqueduct serve <config>   → re-runs eval gate → Hono server: free /schema, paid /query
agent (mppx session mgr)  → GET /query?q=… → 402 → MPP session voucher → 200 + rows + receipt
                          → session.close() → on-chain settle
```

## The spine is deterministic — no LLM required

`deriveConfig()` builds an eval-passed Tap from the inferred schema alone: every column filterable
with type-appropriate ops, all selectable/sortable, `NOT NULL` invariants on required columns. The
cities CSV onboarded **instantly, 2/2 evals, zero model calls**. The LLM (`onboard()`, `--refine`)
is an *optional* polish pass (smarter filter pruning + richer invariants/golden), never load-bearing.

(For reference, the `--refine` LLM path also runs live: real `claude` CLI authored a query interface
+ **5 invariants incl. derived geo bounds** `latitude >= -90 AND latitude <= 90`, validated on retry
attempt 3, 10/10 evals.)

## Request shape (session-correct)

- **GET `/query?q=<base64url JSON>`** — the paid content path.
- **POST `/query`** — the MPP session channel lifecycle (open / voucher / top-up / close).

GET vs POST cleanly separates a data request from the session manager's channel-management POSTs,
which target the same URL. Server uses the combined `tempo({account, currency, feePayer, getClient,
testnet})` method (registers charge + session intents); per route only `amount` + payout vary.

## Cache (hot-path infra)

`runtime/cache.ts` memoizes plan → rows with a TTL keyed on the normalized `QueryPlan`. Cache hit
serves with **no DuckDB and no billing COUNT**; cache miss does a cheap COUNT to price, and runs the
full SELECT only *after* payment clears. Unit-tested (key stability, TTL eviction, duration parse).

## Live payment (`scripts/pay-smoke.ts`)

- Funded server + fresh client/agent wallets via the public faucet (`viem/tempo`
  `Actions.faucet.fund`); confirmed pathUSD balances.
- Unpaid GET `/query` → **402** challenge (paymentauth.org problem+json).
- `tempo.session.manager({ account, getClient, maxDeposit })` auto-handled 402 → signed a session
  voucher → retried.
- Result: **200**, `count: 3`, `amount: "0.0003"` (3 rows × 0.0001), receipt
  `{"method":"tempo","intent":"session","status":"success",…}`, `cumulative: 300`.
- `session.close()` → on-chain settle: `POST /query → 402 → 204`, close receipt
  `status: success`, `reference: 0x90a2…` (the channel settlement ref).

Zero-row queries are **free** (no value delivered, and MPP rejects an amount-0 session).

## Known testnet limitation (environmental, not architectural)

Persistent multi-request channels (auto **top-up**) need an on-chain channel **open**, which the
mppx fee-sponsor policy caps at `maxFeePerGas` 100 gwei. Live Moderato gas is currently ~110 gwei,
so a sponsored open/top-up can be rejected (`FeePayerValidationError: maxFeePerGas exceeds sponsor
policy`). The single-voucher pay + close-settle path above is unaffected and reliable. Fixes for
later: client self-funds non-sponsored gas, or wait for network gas < cap, or a policy override.

## Reproduce

```bash
# 1. onboard — deterministic, no LLM (add --refine for an LLM polish pass)
npm run aqueduct -- onboard path/to/file.csv --recipient 0xYourPayout --out my.tap.json

# 2. live payment smoke (needs network + faucet; funds wallets itself)
npx tsx scripts/pay-smoke.ts my.tap.json

# 3. or serve for real and point any mppx client at it
AQUEDUCT_PRIVATE_KEY=0x... npm run aqueduct -- serve my.tap.json --port 8402
```

## What this closes

The idea-validation gap (`07-idea-validation.md`): 95 live MPP services, ~10 use sessions, **zero
served a static dataset metered per-row over sessions.** Aqueduct does exactly that — from a single
file, deterministically, with the LLM confined to optional onboarding polish (never the hot path).

## Not yet (roadmap, post-MVP)
Hosted deploy (Akash) + persistent session Store (currently in-memory), self-heal loop on eval
drift, SSE per-row streaming, a discovery/demand board. See `08-architecture.md`.
