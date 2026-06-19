---
name: aqueduct
description: Buy specific rows from a metered, agent-payable data feed (an "Aqueduct Tap") over MPP on Tempo. Use when you need precise data from a large external dataset — query by declared filters/columns and pay per row, instead of downloading the whole database.
---

# aqueduct

An **Aqueduct Tap** is a large dataset (parquet/CSV/JSON) served as a metered HTTP API. You ask for
exactly the rows you need with a structured query and pay **per row** over an MPP session on Tempo —
you never download the whole database, and the operator never holds your funds.

## When to use this

Reach for a Tap when answering a question needs **specific facts from a big external dataset** you
don't already have: "the 5 largest settled transactions for account 42", "all sensors in zone B that
read over 90 last hour", "Japanese cities by population". If the data is small and local, just read
it. If you need bulk export, a Tap isn't the cheap path — Taps are for *targeted* reads.

## Finding a Tap (only if you don't already have a URL)

If you were given a Tap URL, skip this. To find one by need, search MPP's public registry — free, no
wallet:

```
npx tsx skills/aqueduct/query.ts --discover "japanese cities"
```

Returns `[{ id, name, url, description, price, currency }]` — Aqueduct Taps only. Pick a `url`, then
run the flow below against it.

> Prefer MCP? The same three ops (discover / schema / query) are also exposed as an MCP server —
> `npx aqueduct-mcp` over stdio. See [docs/mcp.md](../../docs/mcp.md).

## The flow (always in this order)

1. **Discover terms — free.** Read the schema to learn the columns, which fields are filterable, and
   the per-row price. This costs nothing and signs nothing.

   ```
   npx tsx skills/aqueduct/query.ts <tapUrl> --schema
   ```

   Returns `{ name, schema, query, pricing }`. `query` is the **only** surface you may use:
   - `filters`: `[{ field, ops }]` — each field + the operators allowed on it
     (`eq ne lt lte gt gte in like`).
   - `selectable`: columns you may request (or `"*"` for all declared columns).
   - `sortable`: columns you may sort by. `maxLimit` / `defaultLimit`: row caps.

2. **Form a query inside that interface.** Build a JSON request — only declared fields/ops, or it's
   rejected (400) before you pay:

   ```json
   { "select": ["name", "population"],
     "filters": [{ "field": "country", "op": "eq", "value": "JP" }],
     "sort": [{ "field": "population", "dir": "desc" }],
     "limit": 5 }
   ```

   Keep `limit` tight — you pay per returned row. A query matching **0 rows is free**.

3. **Buy the rows — paid.** This opens an MPP session, pays `returned × unitPrice`, and settles on
   close. Requires `AQUEDUCT_AGENT_KEY` (a funded Tempo wallet):

   ```
   AQUEDUCT_AGENT_KEY=0x<key> \
     npx tsx skills/aqueduct/query.ts <tapUrl> '{"filters":[{"field":"country","op":"eq","value":"JP"}],"sort":[{"field":"population","dir":"desc"}],"limit":5}'
   ```

   Returns `{ count, paid, cached, settlement, rows }`. Use `rows` to answer; cite `paid` +
   `settlement` (the on-chain tx) if asked what it cost.

## Rules of thumb

- **Discover before you buy.** Never guess columns/filters — read `--schema` first; an undeclared
  field or operator is a 400 (no charge), not a guess that works.
- **You pay for what's returned.** Narrow with filters and a small `limit`; refine with a cheap
  exploratory query (e.g. `limit 1`) before a larger pull.
- **Repeated identical queries are cached** and still billed, but served instantly.
- **One tool call = one targeted query + settle.** It's a single on-chain settlement per call; batch
  your need into one good query rather than many.

## Not in scope (yet)

For the targeted reads this skill is for, a query returns its (limit-bounded) rows as one JSON body,
which is the right shape. Streaming/SSE for bulk pulls is experimental and undocumented. Live APIs and
SQL/scraped sources are roadmap; Taps today are static parquet/CSV/JSON.
