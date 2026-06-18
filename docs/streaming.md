# Per-row streaming (opt-in)

> **Status: works end-to-end on the Moderato testnet, opt-in via `--stream`.** An agent streams rows
> over SSE, is metered per row, and the channel settles on-chain at close. It requires two fixes to
> mppx's SSE metering, shipped as [`patches/mppx+0.7.0.patch`](../patches/mppx+0.7.0.patch) (applied
> automatically by the `postinstall` hook). Still not the MVP — the default path is per-query
> [`GET /query`](./http-api.md#get-query); streaming is for the bulk / pay-as-you-go shape.

The MVP prices a whole query up front and returns one JSON body. **Streaming** adds a second serve
mode that delivers rows as a [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
stream and **meters one `unitPrice` per row as it's delivered** — MPP's TIP-1034 metered streaming.
The agent pays as it consumes and can stop at any row.

This is the bulk / pay-as-you-go case sessions exist for: an agent pulling from a large feed authorizes
small per-row vouchers over one channel instead of pricing the whole pull at once.

## Serve it

```bash
aqueduct serve exoplanets.tap.json --stream
#   GET  /query              (paid)   one-shot JSON, priced up front      ← MVP
#   GET  /query/stream       (paid)   per-row SSE, pay-as-consumed         ← experimental
```

`--stream` mounts `GET /query/stream` on a **separate Mppx instance** with the SSE transport. SSE is a
per-method transport — flipping it on would change the JSON `/query` response shape — so the two live
on different instances sharing the same wallet, realm, and secret. The MVP routes are untouched.

## The flow

```
GET /query/stream?q=<base64url request>
  → 402 session challenge
  → client opens an on-chain channel (one tx)
  → 200 text/event-stream
  → for each row: server reserves+commits one unitPrice, then emits `event: message`
  → when the channel's voucher is exhausted: `payment-need-voucher` → client POSTs a fresh voucher
  → client disconnects (or stream ends) → channel close settles on-chain
```

Management vouchers (open / voucher / top-up / close) are POSTed by the client's SSE driver to the same
path with the query stripped (`POST /query/stream`); the route handles them as 204 management responses.

## Consume it

```ts
import { streamRows } from "aqueduct-mpp";

for await (const { row, index } of streamRows(tapUrl, request, {
  key: process.env.AQUEDUCT_AGENT_KEY!,      // a funded Tempo wallet
  onReceipt: (r) => {/* per-row receipt */},
  onClose:   (err, receipt) => {/* session-close outcome (see limitation) */},
})) {
  console.log(index, row);
  if (enough(row)) break;                    // stop early → stop paying; the generator closes the session
}
```

`streamRows` yields each row as it arrives and pays per row over one session. Breaking the loop closes
the channel. The request is the same [constrained query](./query.md) the JSON path uses — validated
server-side before any charge.

The bundled demo: `npx tsx scripts/stream-demo.ts` (needs network + the testnet faucet).

## The two mppx patches

Streaming needs two fixes to mppx's SSE session metering ([`patches/mppx+0.7.0.patch`](../patches/mppx+0.7.0.patch)),
both the same bug in parallel code paths. Under SSE, content is metered by the live stream
(`Sse.serve`), so a **`voucher` management post must not be charged as content** — but stock mppx
charges it in two places (`Settlement.applyVerifiedHttpAccounting` and the SSE transport's
plain-response path). That charge double-counts a tick the running stream never credits back into its
`prepaidUnits`, so the next per-row commit fails (`reserved voucher coverage is no longer available`)
and the spurious 402s corrupt the client's voucher accounting, breaking close. The patch skips the
charge for `voucher` posts under SSE; `open` still prepays its single tick. Both are candidates to
upstream. `patch-package` applies them via `postinstall`.

## Known edge: mid-stream disconnect

Consuming the **full** stream settles cleanly. An agent that disconnects *mid-stream* (breaks the loop
early) leaves its close voucher one row short of the server's `spent`, so the close is rejected.
`streamRows` surfaces that via `onClose` (and the read path) instead of throwing, so consumed rows are
never lost — but the channel won't settle until this is handled. Promoting streaming out of opt-in
means fixing this edge and declaring a `streaming` capability in the [Tap config](./config.md)
(invariant 2) rather than a serve-time flag.
