# 03 — TypeScript SDK (`mppx`) Cheatsheet

Most complete MPP SDK. Full reference: `vendor/mpp/src/pages/sdk/typescript/`. Agent skill:
`vendor/mpp/skills/mppx/SKILL.md`.

## Install / CLI

```bash
npm i mppx                  # or pnpm/bun
npx mppx account create     # create testnet-funded account
npx mppx <url>/resource     # make a paid request from the CLI
npx mppx --inspect <url>    # see the 402 challenge WITHOUT paying (debug)
```

## Server — charge (framework middleware)

`pathUSD` on Tempo = currency `0x20c0000000000000000000000000000000000000`. `recipient` = who gets paid.

```ts
// Hono (Next.js / Express / Elysia are analogous: mppx/nextjs, mppx/express, mppx/elysia)
import { Hono } from 'hono'
import { Mppx, tempo } from 'mppx/hono'

const app = new Hono()
const mppx = Mppx.create({
  methods: [tempo.charge({
    currency: '0x20c0000000000000000000000000000000000000', // pathUSD
    recipient: '0xYOUR_ADDRESS',
  })],
  // secretKey defaults to env MPP_SECRET_KEY — keep server-side, never log
})

app.get('/resource', mppx.charge({ amount: '0.1' }), (c) => c.json({ data: '...' }))
```

Per-route override: `mppx.charge({ amount, currency, recipient })`. Dynamic price = compute `amount`
per request (see [05](05-pricing-mechanics.md)).

## Server — session (pay-as-you-go)

```ts
import { Mppx, tempo } from 'mppx/hono'
import { privateKeyToAccount } from 'viem/accounts'

const mppx = Mppx.create({
  methods: [tempo.session({
    account: privateKeyToAccount('0x…'),  // signs settlement + close txs
    currency: '0x20c0000000000000000000000000000000000000',
    recipient: '0xYOUR_ADDRESS',
  })],
})

// charge $0.01 per "photo" unit, billed via off-chain voucher
app.get('/photo', mppx.session({ amount: '0.01', unitType: 'photo' }), (c) => c.json({ url }))
```

## Server — manual mode (any Fetch-compatible runtime)

```ts
import { Mppx, tempo } from 'mppx/server'
const mppx = Mppx.create({ methods: [tempo.charge({ currency, recipient })] })

export async function handler(request: Request) {
  const response = await mppx.charge({ amount: '0.1' })(request)
  if (response.status === 402) return response.challenge          // ask for payment
  return response.withReceipt(Response.json({ data: '...' }))     // verified → attach receipt
}
// Node/Express: wrap with Mppx.toNodeListener(mppx.charge({...}))
```

## Client — pay automatically (agent harness)

```ts
import { Mppx } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const mppx = Mppx.create({ methods: [tempo({ account, maxDeposit: '5' })] }) // auto charge+session

const fetch = Mppx.toFetch(mppx)          // 402-aware fetch (Fetch.from / Fetch.polyfill also exist)
const res = await fetch('https://api.example.com/resource')  // pays transparently on 402
```

Session lifecycle is automatic with `maxDeposit`; for manual control use
`tempo.session.manager(...).fetch()/.topUp()/.close()`.

## MCP monetization

```ts
import { McpClient } from 'mppx'      // client: wrap an MCP client so tool calls pay on 402
import { Transport } from 'mppx/server' // server: Transport.mcp / Transport.mcpSdk to price tools
```

## Discovery (make agents find you)

```ts
import { discovery } from 'mppx/hono'
discovery(app, mppx, { auto: true, info: { title: 'My API', version: '1.0.0' } })
// generates GET /openapi.json with x-payment-info.offers[]; register at mpp.dev/services + mppscan.com
```

## Key modules (reference paths under `src/pages/sdk/typescript/`)

- `client/` — `Mppx.create`, `Fetch.from/.polyfill/.restore`, `Method.tempo[.charge/.session/.subscription]`, `Transport.*`, `McpClient.wrap`
- `server/` — `Mppx.create/.compose/.toNodeListener/.verifyCredential`, `Response.requirePayment`, `Method.*`, `Ws.serve`, middlewares (express/hono/nextjs/elysia)
- `core/` — `Challenge.*`, `Credential.*`, `Receipt.*`, `PaymentRequest.*`, `BodyDigest.*`, `Method.from/.toClient/.toServer`, `Expires`
- `proxy.mdx` — paid API proxy (wrap an existing upstream service behind 402)
