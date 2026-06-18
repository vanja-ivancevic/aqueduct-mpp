# Per-row streaming (experimental)

> **Status: experimental, opt-in.** The data path works end-to-end on the Moderato testnet — but
> session-close voucher reconciliation has a known open issue (see [below](#known-limitation)). Not
> promoted out of experimental, not part of the MVP. The shippable path is per-query
> [`GET /query`](./http-api.md#get-query).

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

## Known limitation

Per-row **delivery and metering work**: the 402 challenge, on-chain channel open, SSE delivery, and
per-row charge all run, and the client consumes streamed rows with per-row receipts. The open issue is
**session close** — once prepaid ticks are involved, the server's `spent` and the client's close
voucher disagree, and the MPP SSE layer aborts the stream. `streamRows` surfaces this through `onClose`
(and the read error) rather than throwing, so rows already consumed are never lost. The accounting lives
inside the MPP SSE session layer, not in Aqueduct — likely an mppx integration detail to raise upstream.

Until close settles cleanly this stays experimental and behind `--stream`. Promoting it means: close
reconciles on-chain, and the capability is declared in the [Tap config](./config.md) (invariant 2)
rather than a serve-time flag.
