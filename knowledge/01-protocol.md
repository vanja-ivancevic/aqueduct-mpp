# 01 — The Protocol (402 flow)

Spec: IETF draft at https://paymentauth.org. Docs: https://mpp.dev/protocol.

## Core control flow

```
Client ──GET /resource──────────────▶ Server
Client ◀─402 + Challenge ───────────── Server   (amount, methods[], pay-to, realm, nonce/expiry)
Client ──GET /resource + Credential ─▶ Server   (signed payment for a chosen method)
Client ◀─200 + resource + Receipt ──── Server   (verified; receipt proves settlement)
```

Same shape as an OAuth `401 → choose provider → authenticate → 200`, but the thing being proven is
**payment** instead of identity. Everything rides standard HTTP request/response — no new transport,
no rendering, no form-clicking. Reuses 20 years of HTTP/web prior art.

## The three artifacts

- **Challenge** — server → client. "You must pay. Here are the accepted payment methods, the amount,
  the recipient, the realm, and validity (nonce/expiry)." Can list *many* methods; client picks.
  SDK: `Challenge.from / .serialize / .fromHeaders / .verify` (`vendor/mpp/src/pages/sdk/typescript/core/`).
- **Credential** — client → server. The signed proof of payment for the chosen method (e.g. a signed
  Tempo transaction, a session voucher, a Stripe token). SDK: `Credential.from / .fromRequest / .serialize`.
- **Receipt** — server → client. Proof the server accepted/settled the payment, attached to the 200.
  SDK: `Receipt.from / .fromResponse / .serialize`.

Plus `PaymentRequest` and `BodyDigest` (binds a credential to a specific request body so it can't be
replayed against a different payload).

## Method-agnostic by design

The protocol defines **only** the control flow + artifact envelopes. Each **payment method** defines
its own rules (settlement, disputes, KYC, pricing) on top. A card charge (disputable, implicit KYC)
and a stablecoin transfer (final, pseudonymous) ride the *same* 402 flow but carry different method
payloads. See [04-payment-methods.md](04-payment-methods.md).

## Transports

The flow works over more than plain HTTP (`vendor/mpp/src/pages/protocol/transports/`):

- **HTTP** — the default. Challenge/credential/receipt in headers + body.
- **MCP / JSON-RPC** — monetize MCP tool calls. A tool call returns a 402-equivalent; client pays and
  re-calls. This is how you put a price on MCP servers. SDK: `Transport.mcp`, `McpClient.wrap`.
- **WebSocket** — long-lived connections / streaming. SDK: `Ws.serve`.

## Discovery (how agents find you)

Servers can publish an OpenAPI doc with `x-payment-info.offers[]` so agents auto-discover the
endpoint and its price. SDK helper: `discovery(app, mppx, { auto: true })`. Public registries:
`https://mpp.dev/services` (the catalog in `services.json`) and `https://mppscan.com`. See
[advanced/discovery] in `llms-full.txt`.

## Related primitives

- **Realm** — namespace/identity for the paying domain (like an auth realm).
- **Identity / Refunds / Security** — `vendor/mpp/src/pages/advanced/*.mdx`. MPP deliberately does
  NOT standardize carts, fraud, disputes, identity beyond the minimum — it's "one solid rail in the
  middle," value accrues to the ecosystem around it.
