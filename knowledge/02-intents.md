# 02 — Payment Intents

An **intent** is the *kind* of payment a method offers. MPP has three. (Source:
`vendor/mpp/src/pages/intents/`, `payment-methods/tempo/session.mdx`, `use-cases/micropayments`.)

## 1. `charge` — one-time, per-request

One payment, one resource, same HTTP request. For amounts above a few cents, settles on-chain
(stablecoin transfer on Tempo). Simplest; what **93 of 95** live services use today.

- Typical price: **$0.01–$0.10 per request**.
- Zero-amount charges skip the transaction entirely (use a `proof` credential) — useful for
  metering free tiers or gating without payment.
- Submission modes: `pull` (client signs, server broadcasts, server can sponsor gas via `feePayer`)
  vs `push` (client broadcasts, sends tx hash). Server handles all payload types automatically.
- `waitForConfirmation: false` → optimistic, lower latency (simulates, doesn't wait for inclusion).

## 2. `subscription` — recurring

Time-based recurring authorization (monthly/daily). Server can `renewSubscription`. For seat/plan
style access rather than metered. SDK: `Method.tempo.subscription`, `tempo.renewSubscription`.

## 3. `session` — off-chain payment channel ⭐ (the cheap, high-volume path)

**This is the primitive for delivering data to agents at the lowest possible cost.** Only **10 of 95**
services use it today — under-adopted relative to its power.

How it works (4 phases — open / session / top-up / close):

1. **Open** — client deposits funds once into a channel reserve via the **TIP-1034 precompile**
   (`channelId` tracks the deposit). One on-chain tx.
2. **Session** — per request, client signs an **off-chain voucher** with a *cumulative* amount ("I've
   now consumed up to X total"). Server verifies the **signature in microseconds** — no RPC, no
   chain call — and grants the delta. Vouchers are **not bottlenecked by block throughput**.
3. **Top up** — refill the channel without closing if it runs low; session continues uninterrupted.
4. **Close** — either party closes with the highest voucher; server settles net balance on-chain in
   one tx, unused deposit **auto-refunds** to the client.

Properties that matter:

- Bills at the granularity of a **single token / API call / byte / row** — amounts as low as
  **$0.0001**, sub-100ms latency, near-zero per-request fee.
- "Thousands of $0.0001 interactions cost a single transaction fee." Only **net settlement** hits
  the chain.
- Session receipt's `reference` = the channel ID (bytes32), not a tx hash (tx hash only exists after
  close).
- Current impl = `tempo.session` (TIP-1034 precompile). Old contract-backed one = `tempo.sessionLegacy`
  (v1, do not use for new builds).

Client APIs:
- `tempo({ account, maxDeposit })` — fetch wrapper handling both charge + session automatically.
- `tempo.session({ account, maxDeposit })` — register only the session client method.
- `tempo.session.manager({ account, maxDeposit })` — explicit lifecycle: `.fetch()`, `.topUp()`,
  `.close()`, `.sse()`, `.ws()`. Use when you must explicitly close/top-up.
- `maxDeposit` caps what the client reserves; unspent is refunded on close. Channels stay open for
  reuse — closing only needed when fully done.

> For the hackathon idea (cheap public data to agents), **sessions are the core mechanism.** See
> [05-pricing-mechanics.md](05-pricing-mechanics.md) and [07-idea-validation.md](07-idea-validation.md).
