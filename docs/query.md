# The query interface

Agents never send SQL. They send an abstract **agent request** that the planner validates against the
Tap's declared **query interface** and compiles to *parameterized* DuckDB SQL. Agent-supplied values
never become SQL text — this is what makes raw/injected SQL unrepresentable.

```
agent request (JSON) ──planQuery──▶ QueryPlan (abstract) ──SourceAdapter──▶ parameterized SQL
   untrusted            validated against        engine-agnostic            values bound as params
                        config.query             plan data
```

## The agent request

Sent to [`GET /query`](./http-api.md#get-query) as base64url-encoded JSON. Every field is optional; an
empty request means "all selectable columns, no filters, `defaultLimit` rows".

```jsonc
{
  "select":  ["title", "weeks_to_publication"], // columns to return; omit → all selectable columns
  "filters": [                            // ALL must hold (AND); each: { field, op, value }
    { "field": "weeks_to_publication", "op": "lt", "value": 12 },
    { "field": "has_apc",              "op": "eq", "value": false }
  ],
  "sort":    [ { "field": "weeks_to_publication", "dir": "asc" } ],  // dir defaults to "asc"
  "limit":   50,                          // clamped to maxLimit
  "offset":  0                            // pagination
}
```

### Operators

| `op` | Meaning | Value |
|------|---------|-------|
| `eq` / `ne` | equal / not equal | a scalar matching the field type |
| `lt` / `lte` / `gt` / `gte` | ordering comparisons | a scalar matching the field type |
| `in` | membership | a non-empty array (≤ 100 values) |
| `like` | SQL `LIKE` pattern | a string — **only allowed on `string` fields** |

A filter is accepted only if the field is declared `filterable` **and** the op is in that field's
allowed-ops list (both come from [`config.query.filters`](./config.md#query)). Value types are checked
against the schema: an `integer` field needs a JS integer, a `boolean` needs true/false, a `timestamp`
must parse as a date. Mismatches are rejected with a located issue — before any charge.

## What the planner enforces

Validation is the security perimeter. The planner (`core/query.ts`) is pure — no I/O, no SQL — and
rejects anything outside the declared interface rather than silently dropping it (an agent paying per
row deserves a clear error, not surprise results):

- **Columns** — every `select` entry must be a schema field *and* selectable. `"*"` interfaces expand
  to the explicit declared column list, so a query can never return an undeclared physical column.
- **Filters** — field must be filterable, op must be allowed on that field, value must match the type.
- **Sort** — field must be in `sortable`.
- **Limits** — `limit` is **clamped** to `maxLimit` (not rejected — friendlier); `offset` clamped to
  the pagination ceiling. Omitting `limit` uses `defaultLimit`.

### Hard caps on an untrusted request

These bound the work an *unpaid* request can force, independent of the config:

| Cap | Limit |
|-----|-------|
| selected columns | 128 |
| filter predicates | 32 |
| sort keys | 16 |
| values in an `in` list | 100 |
| length of a string/like/timestamp value | 512 chars |
| `offset` ceiling | 100,000,000 |
| raw `q` string (before decode) | 256,000 chars |

A request exceeding a structural cap fails parse (`400`); the rest are enforced during planning.

## Example: 15 most prolific no-APC journals with fast review

```jsonc
{
  "select":  ["title", "publisher", "article_records"],
  "filters": [
    { "field": "has_apc",              "op": "eq",  "value": false },
    { "field": "weeks_to_publication", "op": "lte", "value": 12 }
  ],
  "sort":   [ { "field": "article_records", "dir": "desc" } ],
  "limit":  15
}
```

Billed `15 × unitPrice` (only the returned rows — see [pricing.md](./pricing.md)). The same request,
pinned with its expected row count, is exactly what a [`golden` eval](./config.md#evals) checks.
