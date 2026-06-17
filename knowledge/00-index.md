# MPP Knowledge Base — Index

Foundational notes for the Tempo **MPP (Machine Payments Protocol)** hackathon.
Distilled from official docs (https://mpp.dev), the upstream repo, and the IETF spec.

## Map

| File | What |
|---|---|
| [01-protocol.md](01-protocol.md) | The 402 flow: challenge → credential → receipt; transports |
| [02-intents.md](02-intents.md) | charge vs subscription vs **session** (off-chain channels) |
| [03-ts-sdk-cheatsheet.md](03-ts-sdk-cheatsheet.md) | `mppx` client + server snippets, CLI |
| [04-payment-methods.md](04-payment-methods.md) | Tempo (focus) + EVM/Solana/Stellar/Stripe/Card/etc. |
| [05-pricing-mechanics.md](05-pricing-mechanics.md) | per-request / sessions / dynamic pricing — cost math |
| [06-hackathon.md](06-hackathon.md) | Tracks, judged ideas, Tempo's infra wishlist |
| [07-idea-validation.md](07-idea-validation.md) | Landscape scan of 95 live services + idea gaps |
| [08-architecture.md](08-architecture.md) | **Aqueduct / Tap** — the build: components, config, onboarding, demo |
| [09-tempo-testnet-setup.md](09-tempo-testnet-setup.md) | Moderato testnet: chain 42431, faucet, tokens, test-build loop |
| [10-correctness-and-evals.md](10-correctness-and-evals.md) | **The crux** — extraction correctness + eval loops; upstream = oracle |
| [11-review-findings.md](11-review-findings.md) | Adversarial review (codex) — accepted fixes + build backlog |
| [12-onboarding-harness.md](12-onboarding-harness.md) | What the onboarding LLM needs (no web/DB/Python/VPS) — declarative line |
| [13-research-validation.md](13-research-validation.md) | 4-agent validation: DuckDB engine, mppx pipeline (SSE/Store), landscape, query-safety |

## Local references

- `vendor/mpp/` — full upstream clone (read-only). Key paths:
  - `src/data/registry.ts` — service registry types (live data at `/api/services`)
  - `src/pages/sdk/typescript/` — full TS SDK reference (client/server/core/middlewares)
  - `src/pages/sdk/typescript/proxy.mdx`, `src/pages/guides/proxy-existing-service.mdx` — official proxy
  - `src/mppx.server.ts`, `src/mppx-*.server.ts` — runnable demo servers
  - `src/pages/_api/` — demo paid API endpoints (article, search, image, ping, sessions/…)
  - `skills/mppx/SKILL.md` — the agent skill Tempo ships for building with MPP
- `knowledge/raw/` — single-file dumps:
  - `llms-full.txt` (746KB) — entire docs, grep this for anything
  - `llms.txt` — doc index
  - `services.json` (280KB) — full live service catalog (95 services), fetched from `/api/services`
  - `spec-paymentauth.html` — IETF spec landing (https://paymentauth.org)

## One-paragraph primer

MPP turns HTTP **402 Payment Required** into a real, machine-native checkout. A client requests a
resource; the server replies 402 with a **challenge** (amount, accepted payment methods, pay-to
address). The client attaches a **credential** (signed payment) and retries; the server verifies and
returns the resource plus a **receipt**. It is the OAuth-401 pattern, but for value. The protocol is
payment-method-agnostic (Tempo stablecoins, EVM/x402, Solana, Stellar, Stripe, cards…); each method
plugs its own rules into one shared control flow. TS SDK = `mppx`.

## Refresh docs

```bash
git -C vendor/mpp pull
curl -s -o knowledge/raw/llms-full.txt https://mpp.dev/llms-full.txt
curl -s -o knowledge/raw/services.json https://mpp.dev/api/services
```
