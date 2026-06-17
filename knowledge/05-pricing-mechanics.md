# 05 — Pricing Mechanics (cost math for cheap data delivery)

Why MPP makes micropayments work, and how to price **public data for agents** at the floor.
Source: `use-cases/micropayments`, `guides/pay-as-you-go`, `guides/streamed-payments`.

## The problem MPP fixes

Card rails: ~**$0.30 + 2.9%** per transaction → anything under ~$1 loses money. Industry workaround =
subscription bundling (users overpay, occasional buyers excluded). MPP removes the per-tx floor.

## Two mechanisms, by size

| | `charge` (per-request) | `session` (off-chain channel) |
|---|---|---|
| Best for | > a few cents | sub-cent, high volume |
| On-chain cost | one tx **per request** | one tx to open + one to close, **batched** between |
| Latency | block time (~500ms Tempo) | **sub-100ms** (signature check only) |
| Floor price | ~$0.01 practical | **~$0.0001** per row/token/byte |
| Live adoption | 93/95 services | 10/95 services |

**For delivering public data cheaply → sessions win decisively.** Per-request charge re-pays the
chain every call; sessions amortize one settlement over thousands of vouchers.

### Cost intuition

- 10,000 data rows at $0.0001/row = **$1.00** of value, settled in **~2 on-chain txs** (open+close),
  not 10,000. Per-request charge would mean 10,000 txs.
- Verification is CPU-bound signature recovery (microseconds), so throughput scales with the data
  service itself, not the chain.

## Programmable pricing patterns

The price is just code computed per request — enables:

- **Dynamic pricing** — `amount` varies by request cost (bigger query = more). 89/95 live endpoints
  already mark endpoints dynamic.
- **Dynamic rate-limiting via price** — first N req/s free, then linearly more expensive
  (Tempo runs this: 1¢, then 2¢, …). Graceful traffic shaping with economic incentives instead of
  hard 429s.
- **Per-unit billing** — `unitType: 'photo' | 'token' | 'row' | 'byte'`, `amount` per unit.
- **Free tier** — zero-amount charge (`amount: '0'`) gates with a `proof` credential, no payment.
- **Tiered by size** — cheap method under $1 (stablecoin), cards above.

## Implications for the idea

Cheapest public-data-to-agents delivery = **session-billed, per-unit (row/byte), dynamically priced,
gas sponsored by `feePayer` so the agent needs zero native gas token.** That combination is the
lowest-friction, lowest-cost shape MPP supports today — and it's exactly what most existing services
*don't* do (they use flat per-request charge). See [07-idea-validation.md](07-idea-validation.md).
