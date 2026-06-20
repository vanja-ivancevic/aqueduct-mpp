# MCP server

Expose Aqueduct's discover / schema / query flow to any **MCP-capable agent** (Claude Code, Claude
Desktop, …) over stdio. This is the same capability as the [`aqueduct` skill](../skills/aqueduct/SKILL.md)
and the [consumption client](./discovery.md) — a different *transport*, never a different behavior. All
logic lives in `adapters/client`; the server (`mcp/server.ts`) is a thin wrapper, so the skill, the CLI,
and MCP can't drift.

The server is a **consumption client**: it pays remote Taps with the agent's own wallet, agent-side and
non-custodial. It runs no LLM and holds no funds. It lives outside `core/`.

## Run it

```bash
npm run aqueduct-mcp      # from a checkout (tsx mcp/server.ts)
# after `npm link` (or once published to npm): the `aqueduct-mcp` bin, or `npx aqueduct-mcp`
```

It speaks MCP over **stdio** — an MCP client launches it as a subprocess; you don't run it standalone.

## Environment

| Var | Required for | Meaning |
| --- | --- | --- |
| `AQUEDUCT_AGENT_KEY` | `aqueduct_query` only | `0x`-prefixed funded Tempo private key. Discovery and schema are free and need no key. |
| `AQUEDUCT_RPC_URL` | optional | Tempo JSON-RPC endpoint. Defaults to `https://rpc.moderato.tempo.xyz`. |
| `AQUEDUCT_MAX_DEPOSIT` | optional | Session deposit cap passed to the MPP session (defaults to `1`). |

If `AQUEDUCT_AGENT_KEY` is unset, `aqueduct_query` returns a clear error telling you to set it; the two
free tools keep working.

## Client config

Point an MCP client at the server. Example `.mcp.json` (Claude Code) / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aqueduct": {
      "command": "npx",
      "args": ["aqueduct-mcp"],
      "env": {
        "AQUEDUCT_AGENT_KEY": "0xYOUR_FUNDED_TEMPO_KEY",
        "AQUEDUCT_RPC_URL": "https://rpc.moderato.tempo.xyz"
      }
    }
  }
}
```

From a checkout, replace the command with your runner, e.g.
`"command": "npx", "args": ["tsx", "mcp/server.ts"]` (set the client's working directory to the repo).

## Tools

All tool names are prefixed `aqueduct_`. The flow is always **discover → schema → query**.

### `aqueduct_discover` — find Taps (free)

Args: `{ query?: string, registryUrl?: string }`. Searches MPP's public registry for Aqueduct Taps and
returns `[{ id, name, url, description, price, currency }]`. No wallet, signs nothing. Call this first
when you don't already have a Tap URL.

### `aqueduct_schema` — read a Tap's terms (free)

Args: `{ tapUrl: string }`. Returns the Tap's `{ name, schema, query, pricing }` — which columns are
filterable (ops: `eq ne lt lte gt gte in like`), selectable, sortable, the row limits, and the per-row
price. No wallet. Always read this before buying: an undeclared field/op is a free `400`, not a guess.

### `aqueduct_query` — buy rows (spends money)

Args: `{ tapUrl, select?, filters?, sort?, limit?, offset? }` — the constrained query shape from
[query.md](./query.md). **This is the only tool that spends money:** it opens an MPP session and pays
`returned rows × unitPrice` on Tempo, settled on close, using `AQUEDUCT_AGENT_KEY`. Returns
`{ count, amount, cached, settlement, rows }`, where `settlement` is the MPP session receipt reference
(how to confirm the payment: [pricing.md → Verifying payment](./pricing.md#verifying-payment)). A query
matching **0 rows is free** (`count: 0`, `amount: "0"`, no charge) — so build filters from values you
actually saw in `aqueduct_schema`, and keep `limit` tight.

```json
{ "tapUrl": "https://your-tap-host",
  "select": ["title", "publisher_country", "weeks_to_publication"],
  "filters": [{ "field": "has_apc", "op": "eq", "value": false }],
  "sort": [{ "field": "article_records", "dir": "desc" }],
  "limit": 5 }
```
