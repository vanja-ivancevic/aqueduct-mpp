# 09 — Tempo Testnet Setup (test-build Aqueduct)

How to build + test the whole thing on Tempo, free, with testnet wallet + stablecoins.
Verified from `docs.tempo.xyz` + `vendor/mpp/src/pages/payment-methods/tempo/`.

## Networks

| | Chain ID | RPC | Explorer |
|---|---|---|---|
| **Testnet (Moderato)** ← build here | **42431** | `https://rpc.moderato.tempo.xyz` (ws: `wss://…`) | `https://explore.testnet.tempo.xyz` |
| Mainnet | 4217 | `https://rpc.tempo.xyz` | `https://explore.mainnet.tempo.xyz` |

> ⚠️ Moderato chain ID is **42431** (not 4217 — that's mainnet). viem: `tempoModerato`.

## Tokens (TIP-20 stablecoins) — testnet faucet gives 1M each

| Asset | Address |
|---|---|
| **pathUSD** (default) | `0x20c0000000000000000000000000000000000000` |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` |
| BetaUSD | `0x20c0000000000000000000000000000000000002` |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` |

**Session reserve precompile (TIP-1034):** `0x4d5050000000000000000000000000000000000  0` (same testnet+mainnet).
`autoSwap` lets a client swap a fallback stablecoin via the Tempo DEX if it lacks the requested currency.

## Faucet — programmatic, any address, no signup/wallet, no documented rate limit

```bash
# API
curl -X POST https://docs.tempo.xyz/api/faucet -H "Content-Type: application/json" -d '{"address":"0x…"}'
# RPC
cast rpc tempo_fundAddress 0x… --rpc-url https://rpc.moderato.tempo.xyz
```
→ fund operator + agent test wallets in a script. Fully reproducible, zero real money.

## Wallets / accounts

- **Dev:** raw viem key — `privateKeyToAccount('0x…')`, fund via faucet. Or `npx mppx account create`
  (creates a funded testnet account). This is all the test-build needs.
- **End-user UX (later):** `https://accounts.tempo.xyz` = "Tempo Accounts", managed/embedded wallet
  service — the operator-facing wallet option, not required for dev.

## Aqueduct test-build loop (all on Moderato, free)

```
1. faucet-fund operator wallet + agent wallet (pathUSD)
2. Tap runtime: mppx hono, tempo.session({
     chainId: 42431, currency: pathUSD, recipient: operator, feePayer: true })
3. agent: Mppx.create({ methods:[tempo({ account, maxDeposit })] }) → pays per row
4. verify on explore.testnet.tempo.xyz: channel open + net settle txs; vouchers off-chain
smoke: npx mppx --inspect <url>  (view challenge, no pay) ; npx mppx <url>/row  (pay)
```

The full core loop — onboard→validate, Tap runtime, agent pays per row, self-heal eval-gate — is
free + reproducible here.

## Two gotchas: what testnet can't cover (free substitutes exist)

| Flourish | Why it needs mainnet | Dev substitute |
|---|---|---|
| **Akash hosting** | escrow wants real (mainnet) USDC, not Moderato coins | deploy to normal/local host for the loop; pre-provision Akash once for the live "wow" |
| **LLM-over-MPP** (OpenRouter `*.mpp.tempo.xyz`) | settles on **mainnet** pathUSD = real money/call | dev with **BYO-key** LLM (free); switch to MPP-paid only for the demo moment |

Neither blocks building — both crypto-native flourishes have free dev paths. Only the live demo
touches mainnet (small, deliberate).
