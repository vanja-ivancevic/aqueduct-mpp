# 06 — Hackathon Notes (Tempo / MPP)

From the Tempo MPP hackathon talk (Brandon, ex-Strike → Tempo Labs) + docs.

## Two tracks

- **Applications** — interesting things built *with* MPP. Common shapes: APIs, **data feeds**, MCP
  servers (no good monetization model today), agent-only games (chess, "5-D poker"). Random live
  examples: a vineyard, a Brooklyn butcher, a billboard-on-X.
- **Infrastructure** — tools that help app builders build more. ← **our lean.**

## Tempo's stated infra wishlist (direct from the talk)

These are the things they explicitly want built — strong signal for judging:

1. **Frameworks** that make spinning up MPP services even easier (less code than the 4-line server).
2. **Hosted / no-code services** — let people stand up paid endpoints without writing code.
3. **New payment methods** — esp. **cross-chain**: "pay with currency on chain A, settle on chain B"
   over MPP. Flagged as actively wanted, partner already asking.
4. **Observability** — what is my agent doing right now? Is it spending correctly? Tracking spend.
   ("Nobody's really solved this.")
5. **Spend controls / policies / risk** — cap an agent to $5, off-chain + on-chain enforcement.
6. **Harness integrations** — wiring MPP into common agent harnesses.

## Protocol facts worth repeating to judges

- MPP = machine-native checkout over HTTP **402**; reuses 20 yrs of web prior art; OAuth-shaped.
- Method-agnostic; the protocol itself captures **no** value — value accrues to the surrounding
  ecosystem (ease-of-use à la Stripe; risk management à la Visa). Tempo accrues value only when
  payments settle on Tempo. So infra that drives Tempo volume is aligned with the sponsor.
- The hard problems they intentionally **don't** standardize: carts, fraud, disputes, identity.

## Winning criteria (from intro-talk slides)

- **Judged by the Tempo team, per category** (app vs infra).
- **In-person pitch required** — every team pitches live; **must be present at the 4 PM ceremony**.
- Judges look for:
  1. **Functionality** — does it work and solve a *real* problem?
  2. **Creativity** — is the idea original and inventive?
  3. **Polish** — how complete and refined is it?

Implication for us: pick a wedge that *demonstrably works end-to-end* (Functionality) on the
under-used session primitive (Creativity), and ship one **live, refined demo** rather than broad
scaffolding (Polish). A single working "open dataset → session-billed MPP feed + agent paying it
live" beats a half-built framework.

## Build constraints / facts

- Stack: **TypeScript / `mppx`** (most complete SDK). Testnet = `tempoModerato`,
  RPC `https://rpc.moderato.tempo.xyz`, faucet via `npx mppx account create`.
- pathUSD currency `0x20c0000000000000000000000000000000000000`.
- Sessions (TIP-1034) are the differentiated, under-used primitive — lean into them.
- Register builds at `mpp.dev/services` + `mppscan.com` for discovery cred.

## Our direction (working)

Infra: **deliver public data to agents at the lowest possible cost.** Validated against the live
catalog in [07-idea-validation.md](07-idea-validation.md). The wedge: public-data services exist in
bulk but **almost none use sessions** — the cheapest mechanism — and there's no generic framework to
turn an arbitrary open dataset into a session-billed, per-row, gas-sponsored MPP feed.
