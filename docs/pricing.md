# Pricing & billing

A Tap charges by a **declared cost unit**. The MVP unit is the **row**: a query is billed
`rowsReturned × unitPrice`, settled over an MPP session on Tempo. Aqueduct is **non-custodial** — it
never holds funds; settlement is peer-to-peer between agent and operator.

## The price

From [`config.pricing`](./config.md#pricing):

```jsonc
{ "unit": "row", "unitDefinition": "one returned row", "unitPrice": "0.0001", "currency": "0x20c0…" }
```

- `unitPrice` is a **decimal string** (e.g. `"0.0001"`), never a float — money math is exact.
- `currency` is the settlement token address (testnet **pathUSD** by default).
- A zero price is invalid: an MPP session can't charge `0`.

## How a request is billed

```
amount = unitsCost(unitPrice, count)        // count = rows actually returned
```

`unitsCost` multiplies via BigInt (scale the decimal to an integer, multiply, format back) so there is
no float drift even at `"0.0000001"` prices. Examples at `unitPrice = "0.0001"`:

| rows returned | `amount` |
|---------------|----------|
| 0 | `"0"` (free — no charge made) |
| 1 | `"0.0001"` |
| 15 | `"0.0015"` |
| 1000 | `"0.1"` |

### You pay for what you get

The charge is on **returned** rows, after `limit` clamping — not the number of rows scanned, not the
size of the dataset. A query that matches nothing delivers no value and is **free** (`amount: "0"`, no
payment required). The price is computed from a cheap pre-charge `COUNT`; the full `SELECT` runs only
after the payment clears.

## Settlement: the MPP session

The `mpp.intent` is `session` — an off-chain payment channel (TIP-1034):

1. **First query** → server replies `402` with a challenge.
2. Client's session manager **opens a channel** (one on-chain op) and signs a **cumulative voucher**.
3. The retry clears to `200`; rows come back with a **receipt**.
4. **Subsequent queries** on the same channel are just new signed vouchers — no further on-chain ops.
5. **Close** settles the final cumulative voucher on-chain — **one** settlement for the whole session.

This is what makes sub-cent per-row billing economical: thousands of `0.0001` charges cost a single
transaction fee at close, not one per request.

### Verifying payment

The client (`buyRows`, the MCP `aqueduct_query` tool, the skill CLI) returns a `settlement` field — the
MPP **receipt reference** for the session (`method: "tempo"`, a `0x…` reference from the channel close).
It identifies the settlement within MPP; it is **not** guaranteed to be a plain EOA transaction
resolvable via `eth_getTransactionByHash` on the public RPC (Tempo settles channels through a precompile,
so the reference may not surface as a normal transaction).

The ground-truth proof that money moved is the **agent wallet's pathUSD balance delta**: it drops by the
data charge (`rows × unitPrice`) plus the on-chain gas the agent paid to open and settle the channel.

```ts
import { createClient, http } from "viem";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { DEFAULT_RPC_URL, PATH_USD } from "./core/constants";

const client = createClient({ chain: tempoModerato, transport: http(DEFAULT_RPC_URL) });
const bal = () => Actions.token.getBalance(client, { account: agentAddress, token: PATH_USD });
// before = await bal();  … run the paid query …  after = await bal();
// (before - after) = data charge + channel gas, both paid non-custodially from the agent's wallet.
```

### Gas sponsorship (optional)

`mpp.feePayer: true` lets the operator sponsor agents' on-chain channel gas — but only when `serve`
runs with a **separate** funded `AQUEDUCT_SPONSOR_KEY` wallet. Tempo rejects a sponsored tx whose
fee-payer equals the sender, so the sponsor must differ from the settlement wallet. Without a sponsor,
agents self-pay gas. See the [environment table](../README.md#environment).

## Where margin comes from

The [result cache](./config.md#cache): a cache hit serves rows for the same `unitPrice` without
touching the source — no upstream fetch, no DuckDB scan. Cache correctness is therefore treated as
production code, not a nicety.
