# 04 — Payment Methods

A **method** plugs settlement rules into the shared 402 flow. Each declares which **intents** it
supports (charge / subscription / session) and which **assets**. Docs:
`vendor/mpp/src/pages/payment-methods/`.

## Tempo (the headline — Stripe's blockchain)

Stablecoin payments on Tempo (~500ms blocks). Default for this hackathon; **all 93 charge-using
live services settle on Tempo**.

- Currency: TIP-20 tokens. **pathUSD** = `0x20c0000000000000000000000000000000000000`.
- Intents: `charge`, `session` (TIP-1034 precompile channels), `subscription`.
- Gas sponsorship: server can pay client gas via `feePayer` (account or fee-payer service URL).
- Testnet: `tempoModerato` chain, RPC `https://rpc.moderato.tempo.xyz`. Explorer: explore.tempo.xyz.
- SDK import: `tempo` from `mppx/server` (or framework variant). See [03](03-ts-sdk-cheatsheet.md).

## Other methods at a glance

| Method | Intents (per docs) | Notes |
|---|---|---|
| **EVM** | charge | Generic EVM / **x402-compatible**. Bridges to the x402 ecosystem. |
| **Stripe** | charge | Cards via Stripe; settles in `usd`. 9 live services also offer this. |
| **Card** | charge | Raw card method. Disputable, implicit KYC — different risk model than crypto. |
| **Solana** | charge | SPL token transfers. |
| **Stellar** | charge, channel (session) | SEP-41 tokens; "channel" = session-equivalent. |
| **Monad** | charge | EVM L1. |
| **Lightning** | charge, session | Bitcoin Lightning; native streaming/session fit. |
| **RedotPay** | charge | Localized payment method. |
| **Custom** | — | Define your own method (`Method.from`). Infra-track opportunity. |

## Multi-method & negotiation

- A challenge can advertise **many** methods at once; the client picks by cost/preference. Agents can
  scan hundreds of methods (humans can't) and pattern-match the optimal one.
- **Dynamic method selection**: server returns different methods by circumstance — e.g. under $1 →
  stablecoin only (cards uneconomic), over $1 → cards or stablecoin. (`guides/multiple-payment-methods`.)
- **x402 interop**: `guides/use-mpp-with-x402` + `mpp-vs-x402` — MPP is a superset; key MPP edge is
  **sessions** (x402 needs an on-chain tx per request; MPP sessions settle off-chain vouchers).
- **Cross-chain** ("pay on chain A, settle on chain B") is explicitly an open infra problem Tempo
  flagged — see [06](06-hackathon.md).

## Assets seen live (from `services.json`)

- `0x20c0…b9537d11c60e8b50` (a Tempo TIP-20 stablecoin) on 93 services.
- `usd` on the 9 Stripe services.
