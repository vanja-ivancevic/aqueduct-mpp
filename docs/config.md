# The Tap config

The config is the **single source of truth for a Tap's behavior** (CLAUDE.md invariant 2). It is a
frozen, versioned JSON artifact written by [onboarding](../knowledge/12-onboarding-harness.md) and
executed verbatim by the runtime. Nothing here is logic — it is a declarative description of where the
data is, its schema, the query interface agents may use, pricing, caching, and evals.

## Validity is two-staged

```
unknown ──parseConfig──▶ TapConfig ──eval gate (validate)──▶ ValidatedConfig
         structural +              eval-passed; the ONLY type the runtime will serve
         semantic checks
```

`parseConfig` checks structure and cross-field rules. The **eval gate** (`validate`) then runs the
suite against real data; only on a pass does the config become a `ValidatedConfig`. The type system
makes "serve an un-evaluated config" unrepresentable — `createTapServer` accepts `ValidatedConfig` only.

## Top-level shape

```jsonc
{
  "version": 1,
  "name": "exoplanets",            // kebab-case identifier, ^[a-z][a-z0-9-]*$
  "source":  { … },                // where the file is + its source contract
  "schema":  [ … ],                // the output columns
  "query":   { … },                // the constrained query interface
  "pricing": { … },                // billing terms
  "cache":   { … },                // result-cache TTL
  "evals":   { … },                // the correctness gate
  "mpp":     { … }                 // settlement (MPP session on Tempo)
}
```

`version` is fixed at `1`. The object is `strict` — unknown keys are rejected, so a typo'd field fails
parse rather than being silently ignored.

---

## `source`

Where the data lives and the contract under which it's served.

```jsonc
"source": {
  "format": "csv",                 // "parquet" | "csv" | "json"
  "location": { "via": "path", "ref": "examples/exoplanets.csv" },
  "authEnv": null,                 // env var name for an upstream credential, or null
  "contract": {
    "determinism": "deterministic", // "deterministic" | "volatile" | "personalized"
    "freshnessWindow": "24h"        // how long a snapshot is advertised as current
  }
}
```

- `location.via` — `"url"` fetches over HTTP (DuckDB reads remote parquet via range requests, no full
  download); `"path"` reads a local file / baked snapshot.
- `contract` — the **source contract**, the declared basis for any correctness claim. MVP serves static
  files, so the contract is just a determinism class + freshness window. Richer terms (volatility,
  identity scope) arrive with volatile sources; declaring fields the runtime ignores would be dishonest.

---

## `schema`

The output columns. At least one. Each field:

```jsonc
{ "name": "distance_pc", "type": "number", "required": true }
```

### Field types

| `type` | Accepts | Notes |
|--------|---------|-------|
| `string` | text | |
| `integer` | whole numbers | filter values must be JS integers |
| `number` | any number | |
| `boolean` | true/false | |
| `timestamp` | ISO-8601 string | must parse, or the filter is rejected pre-charge |
| `json` | any | structured/nested values pass through |

The schema is also the security boundary for output: a query can only ever return declared columns,
never a physical column the schema omits.

---

## `query`

The **constrained query interface** — full reference in [query.md](./query.md). Summary:

```jsonc
"query": {
  "filters": [ { "field": "distance_pc", "ops": ["lt", "lte", "gt", "gte"] } ],
  "selectable": "*",               // "*" = all schema fields, or an explicit allow-list
  "sortable": ["distance_pc"],
  "maxLimit": 1000,                // hard ceiling on rows per request
  "defaultLimit": 100              // applied when the agent omits `limit`; must be <= maxLimit
}
```

Every `filters[].field`, `sortable[]`, and (if not `"*"`) `selectable[]` entry must name a declared
schema field — `parseConfig` rejects references to undeclared fields.

---

## `pricing`

What a request costs. Full reference in [pricing.md](./pricing.md).

```jsonc
"pricing": {
  "unit": "row",                   // "row" | "page" | "query" | "byte" | "result-set"
  "unitDefinition": "one returned row",
  "unitPrice": "0.0001",           // decimal STRING, never a float; must be > 0
  "currency": "0x20c0…"            // settlement token address (testnet pathUSD by default)
}
```

`unitPrice` is a decimal string so money math stays exact. A zero price is rejected — an MPP session
can't charge `0`, so a paid Tap can't be free. (Zero-*row* queries are still free; that's a runtime
behavior, not a price of zero.)

---

## `cache`

```jsonc
"cache": { "key": "queryHash", "ttl": "1h" }
```

Results are cached by a hash of the planned query for `ttl`. A hit serves rows without touching the
source — this is the `<100 ms` cached path. `key` is fixed at `"queryHash"`.

**Auto-refresh.** When the source `location.via` is `"url"`, the `ttl` *is* the refresh cadence: once a
cached result expires, the next query re-reads the live source, so served data is never older than
`ttl`. A builder keeps the upstream current (their own pipeline); the Tap pulls it on this cadence — no
cron in the runtime.

**Invariant: `cache.ttl` ≤ `source.contract.freshnessWindow`.** A cache hit may serve a result up to
`ttl` old, and the freshness window is the staleness the Tap *advertises* — so the cache must not
outlive it. `parseConfig` rejects a config that promises fresher data than it actually refreshes. This
is what makes `freshnessWindow` an honored guarantee, not a label.

---

## `evals`

The correctness gate. Runs at onboarding, on every repair, and again before `serve` (a config is never
trusted blindly). Produces the published correctness score.

```jsonc
"evals": {
  "golden": [                      // pinned request → expected row count (a deterministic tripwire)
    { "request": { "filters": [{ "field": "method", "op": "eq", "value": "Transit" }] }, "expectRowCount": 1100 }
  ],
  "invariants": ["distance_pc >= 0"], // SQL booleans that must hold for EVERY row (frozen, trusted)
  "sampleSize": 20                 // rows sampled for the schema-conformance check
}
```

Always-on checks (not configurable): **coverage** (source has rows), **schema** (a sample conforms to
the declared types), **golden** (pinned counts hold), **invariants** (the SQL booleans hold for all
rows). Only `sampleSize` is tunable. See [knowledge/10](../knowledge/10-correctness-and-evals.md).

---

## `mpp`

Settlement. MVP is an MPP **session** on Tempo.

```jsonc
"mpp": {
  "intent": "session",             // fixed: off-chain channel, signed vouchers, one on-chain settle
  "recipient": "0x…",              // payout address (where settlement lands)
  "currency": "0x20c0…",           // settlement token (matches pricing.currency)
  "feePayer": true                 // may sponsor agent gas — only honored if a DISTINCT sponsor wallet is configured at serve time
}
```

`feePayer: true` only takes effect when the operator runs `serve` with a separate
`AQUEDUCT_SPONSOR_KEY` wallet (Tempo rejects a sponsored tx whose fee-payer equals the sender). Without
one, agents self-pay gas. See the [environment table](../README.md#environment).

---

## Why it's frozen

Because the config is the only thing that governs behavior, a Tap is fully portable and auditable: the
same artifact produces the same Tap anywhere, and a reviewer can read *exactly* what a feed will do —
its columns, its limits, its price, its correctness checks — without reading any code. Runtime *state*
(cache, session ledger, scores) is separate and explicitly named; it never leaks into the config.
