# Discovery & consumption

How an agent **finds** a Tap and **buys** from it. Aqueduct hosts **no directory of its own** —
discovery rides entirely on MPP's existing public registry. We add nothing central.

## Two layers of discovery

1. **Per-Tap, live: `GET /schema`.** Every Tap self-describes for free — columns, the constrained
   query interface, the price. If an agent already has a Tap URL (from a builder's site, a link), this
   is all it needs; no registry involved. See [http-api.md](./http-api.md#get-schema).
2. **Aggregate, find-by-need: MPP's registry.** The public list at **`https://mpp.dev/api/services`**
   (`{ version, services[] }`) indexes every MPP service. An agent that needs "a dataset about X"
   searches this list. We read it; we never host it.

## Publishing a Tap — `aqueduct register`

A Tap is published by adding a `Service` entry to MPP's registry. `aqueduct register` renders that
entry from the frozen config + the URL you deployed at:

```bash
aqueduct register exoplanets.tap.json --url https://your-tap-host \
  --provider-name "Acme Data" --provider-url https://acme.example
```

It prints the entry to stdout. Every field derives from the config — id/name, `methods.tempo`, the
free `GET /schema` + paid `GET /query` endpoints, `recipient`, and an `amountHint` of
`unitPrice/unit`. The entry is tagged **`aqueduct`** so clients can pick it out of the ~80 unrelated
data services.

To get it into the canonical registry: open a PR adding the entry to `schemas/services.ts` in
[`tempoxyz/mpp`](https://github.com/tempoxyz/mpp) — **curated, not instant** (there's a CI review
gate). Until merged, agents reach the Tap directly by URL; `/schema` is free and self-describing, so a
registry listing is a reach upgrade, not a requirement.

## Consuming a Tap — three read ops

The skill and the MCP server are both thin transports over one shared client
([`adapters/client/client.ts`](../adapters/client/client.ts)). Same three ops either way:

| op | wallet? | what it does |
|----|---------|--------------|
| `discover(query?)` | no | search MPP's registry → Aqueduct Taps matching the text |
| `schema(url)` | no | read a Tap's terms before paying |
| `query(url, request)` | **yes** | buy exactly the rows selected — `rows × unitPrice` over one MPP session |

The wallet stays **agent-side** (`AQUEDUCT_AGENT_KEY`). There is no hosted/shared payer — a central
one would hold funds and break non-custody (the non-custody invariant).

### Via the Claude skill

`skills/aqueduct/` — markdown the agent reads + a `query.ts` it runs:

```bash
npx tsx skills/aqueduct/query.ts --discover "japanese cities"     # find
npx tsx skills/aqueduct/query.ts <tapUrl> --schema                # inspect (free)
AQUEDUCT_AGENT_KEY=0x… npx tsx skills/aqueduct/query.ts <tapUrl> '{"filters":[…],"limit":5}'  # buy
```

### Via the MCP server

`npx aqueduct-mcp` runs an MCP **stdio** server exposing the same ops as tools — `aqueduct_discover`,
`aqueduct_schema`, `aqueduct_query` — for any MCP-native host (Claude Desktop, Cursor, …). Run it
locally with your own wallet:

```jsonc
// e.g. an MCP client config
{
  "mcpServers": {
    "aqueduct": {
      "command": "npx",
      "args": ["aqueduct-mcp"],
      "env": { "AQUEDUCT_AGENT_KEY": "0x<funded-tempo-key>" }
    }
  }
}
```

`aqueduct_query` pays with that key over a session and settles on close. Form the request from
`aqueduct_schema` first — undeclared fields/ops are rejected before any charge, and a zero-row match
is free.
