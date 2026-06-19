# HTTP API

A served Tap exposes exactly three routes. One is free discovery; two carry the MPP session payment
flow. There is no other surface — no admin routes, no raw SQL, no LLM endpoint.

| Route | Cost | Purpose |
|-------|------|---------|
| [`GET /schema`](#get-schema) | free | discovery — columns, query interface, pricing |
| [`GET /query?q=…`](#get-query) | paid | the data — one MPP session voucher per query |
| [`POST /query`](#post-query) | — | MPP session channel lifecycle (open / top-up / close) |

The split is deliberate: `GET /query` is the content path, `POST /query` is the session manager's
channel-management path. Using different verbs on the same URL keeps the two unambiguous.

---

## `GET /schema`

Free. Returns everything an agent needs to form a paid query and decide whether to pay. No payment,
no side effects.

**Response** `200 application/json`:

```json
{
  "name": "doaj-journals",
  "schema": [
    { "name": "title",     "type": "string",  "required": false },
    { "name": "publisher", "type": "string",  "required": false },
    { "name": "has_apc",   "type": "boolean", "required": false }
  ],
  "query": {
    "filters": [
      { "field": "has_apc",           "ops": ["eq", "ne"] },
      { "field": "publisher_country", "ops": ["eq", "ne", "in", "like"] }
    ],
    "selectable": "*",
    "sortable": ["article_records", "weeks_to_publication"],
    "maxLimit": 1000,
    "defaultLimit": 100
  },
  "pricing": {
    "unit": "row",
    "unitDefinition": "one returned row",
    "unitPrice": "0.0001",
    "currency": "0x20c0000000000000000000000000000000000000"
  }
}
```

- `schema` — the columns and their [types](./config.md#field-types).
- `query` — the [constrained query interface](./query.md): which fields are filterable (and with which
  operators), which are selectable/sortable, and the limit ceiling.
- `pricing` — the [billing terms](./pricing.md): unit, price per unit, settlement token address.

---

## `GET /query`

Paid. The agent request rides in a single query parameter `q`: **base64url-encoded JSON** matching the
[agent request shape](./query.md#the-agent-request). An empty/absent `q` means "default query"
(all selectable columns, no filters, `defaultLimit` rows).

```
GET /query?q=eyJmaWx0ZXJzIjpbeyJmaWVsZCI6Im1ldGhvZCIsIm9wIjoiZXEiLCJ2YWx1ZSI6IlRyYW5zaXQifV0sImxpbWl0Ijo1MH0
```

### Payment flow

The first call has no payment credential, so the server answers `402` with an MPP challenge. The
client's session manager opens a channel (or reuses an open one), signs a cumulative voucher, and
retries — the retry clears to `200`. After the first open, subsequent queries on the same channel are
just signed vouchers (no new on-chain op).

```ts
import { tempo } from "mppx/client";

const session = tempo.session.manager({ account, getClient, maxDeposit: "1" });
const q = Buffer.from(JSON.stringify({
  filters: [{ field: "method", op: "eq", value: "Transit" }],
  limit: 50,
})).toString("base64url");

const res = await session.fetch(`${tap}/query?q=${q}`); // 402 → voucher → 200
const { rows, count, amount } = await res.json();
await session.close();                                  // settle the cumulative voucher on-chain
```

### Response `200 application/json`

```json
{ "rows": [ { "title": "PLOS ONE", "publisher": "Public Library of Science", "has_apc": true } ], "count": 1, "amount": "0.0001", "cached": false }
```

| Field | Meaning |
|-------|---------|
| `rows` | the matching rows, already limited to `limit` |
| `count` | number of rows returned (== `rows.length`) |
| `amount` | what this query was billed: [`count × unitPrice`](./pricing.md) as a decimal string |
| `cached` | whether the rows came from the TTL result cache (a cache hit never touches DuckDB) |

A successful paid response carries an MPP **receipt** (added by `withReceipt`) so the client can verify
the charge against the voucher.

### Zero-row queries are free

If a query matches no rows, no value is delivered, so **no charge is made** — the response is
`200 { "rows": [], "count": 0, "amount": "0" }` with no payment required. (The empty result is cached so
a repeated zero-row query can't force an unpaid DuckDB count each time.)

### Status codes

| Code | When | Body |
|------|------|------|
| `200` | rows served (paid) or zero-row free result | `{ rows, count, amount, cached }` |
| `400` | `q` is malformed, or the request violates the [query interface](./query.md) | `{ error: "…" }` or `{ error: [issues] }` |
| `402` | payment required — MPP challenge (the session manager handles this automatically) | MPP challenge |
| `502` | the query was valid but the source engine could not evaluate it | `{ error: "…" }` |

`400` is returned **before** any charge — an invalid request never costs money. The planner reports
located issues (e.g. `field 'foo' is not filterable`, `op 'like' not allowed on 'has_apc'`) so the
agent can fix and retry. Pricing is computed from a pre-charge `COUNT`; the full `SELECT` runs only
after payment clears.

---

## `POST /query`

The MPP **session channel lifecycle** — open, top-up, voucher, close. The client's session manager
drives this; you do not call it by hand. It carries no application content and no per-row charge; the
session method consumes the management credential and returns its response directly.

---

## Notes

- **Caching.** Results are cached by query hash with the config's `cache.ttl`. A hit serves the same
  rows without touching the source — this is where both the `<100 ms` latency and the margin come from.
- **Bounds.** `q` is capped at 256,000 chars before decode; the [planner](./query.md) caps the parsed
  request (≤128 selected columns, ≤32 filters, ≤16 sort keys, ≤100 `in` values). These bound the work
  an *unpaid* request can force.
- **No SQL, ever.** The agent request is abstract data. The planner turns it into a parameterized
  DuckDB query; agent-supplied values never become SQL text. See [query.md](./query.md).
