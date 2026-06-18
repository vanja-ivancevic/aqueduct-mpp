/**
 * Streaming Tap route (EXPERIMENTAL) — pay-as-you-consume row streaming over MPP SSE.
 *
 * The MVP path (`GET /query`) prices a whole request up front and returns one JSON body. This adds a
 * second, opt-in path (`GET /query/stream`) that emits rows as a Server-Sent Events stream and charges
 * **one unitPrice per row as it's delivered** (TIP-1034 metered streaming). The agent can stop early
 * and pays only for rows it actually consumed — the bulk / pay-as-you-go case sessions exist for.
 *
 * It lives on its own Mppx instance because SSE is a per-method transport: flipping `sse:true` changes
 * the session response shape, which would break the JSON `/query` on the shared instance. Same wallet,
 * realm, and secret as the MVP server — only the transport differs. Still no LLM on the path; the
 * generator is pure config execution, metered by the SDK.
 *
 * Not yet config-governed (invariant 2): enabled by a serve-time flag while we prove it out. Promoting
 * it to a declared `streaming` capability in the Tap config is the follow-up before it leaves
 * experimental.
 *
 * STATUS (experimental, verified on Moderato testnet): the data path works end-to-end — 402 session
 * challenge → on-chain channel open → per-row SSE delivery → the client consumes rows and the per-row
 * metering charges as they're delivered. OPEN ISSUE: multi-tick voucher reconciliation at session
 * *close* mismatches (server `spent` vs the client's close voucher) once prepaid ticks are involved —
 * the accounting lives inside the MPP SSE session layer, not here. Likely an mppx integration detail
 * to raise upstream. The client surfaces the close outcome via `onClose` instead of throwing, so the
 * streamed rows are never lost. Do not promote out of experimental until close settles cleanly.
 */
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { Mppx, Store, tempo } from "mppx/server";
import { http, type Account, createClient } from "viem";
import { tempoModerato } from "viem/chains";
import type { DuckDbEngine } from "../adapters/source/duckdb";
import type { ValidatedConfig } from "../core/config";
import { DEFAULT_RPC_URL } from "../core/constants";
import { planQuery, queryPolicy } from "../core/query";

const DEFAULT_SUGGESTED_DEPOSIT = "1";
const DEFAULT_SPONSOR_MAX_FEE_PER_GAS = 100_000_000_000n; // 100 gwei
const DEFAULT_SPONSOR_MAX_PRIORITY_FEE_PER_GAS = 50_000_000_000n;

export interface StreamRouteOptions {
  account: Account;
  sponsorAccount?: Account;
  rpcUrl?: string;
  realm?: string;
  secretKey?: string;
  suggestedDeposit?: string;
  sponsorMaxFeePerGas?: bigint;
  /** Inject the channel store (defaults to in-memory). Explicit named state — invariant 3. */
  store?: ReturnType<typeof Store.memory>;
}

/** Mount `GET /query/stream` on an existing Hono app. Additive — does not touch the MVP routes. */
export function mountStreamRoute(
  app: Hono,
  config: ValidatedConfig,
  engine: DuckDbEngine,
  opts: StreamRouteOptions,
): void {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const mppx = Mppx.create({
    methods: [
      tempo({
        account: opts.account,
        currency: config.mpp.currency,
        feePayer: config.mpp.feePayer && opts.sponsorAccount ? opts.sponsorAccount : undefined,
        feePayerPolicy: {
          maxFeePerGas: opts.sponsorMaxFeePerGas ?? DEFAULT_SPONSOR_MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: DEFAULT_SPONSOR_MAX_PRIORITY_FEE_PER_GAS,
        },
        testnet: true,
        getClient() {
          return createClient({ chain: tempoModerato, transport: http(rpcUrl) });
        },
        // SSE metering needs a linearizable channel store; one process → in-memory is correct.
        sse: true,
        store: opts.store ?? Store.memory(),
      }),
    ],
    realm: opts.realm ?? "aqueduct",
    secretKey: opts.secretKey ?? randomBytes(32).toString("hex"),
  });

  const policy = queryPolicy(config);
  const suggestedDeposit = opts.suggestedDeposit ?? DEFAULT_SUGGESTED_DEPOSIT;
  // tickCost = one row's price: the SDK charges this per yielded value, as it's delivered.
  const charge = mppx.session({
    amount: config.pricing.unitPrice,
    unitType: config.pricing.unit,
    recipient: config.mpp.recipient,
    suggestedDeposit,
  });

  app.get("/query/stream", async (c) => {
    const q = c.req.query("q");
    let body: unknown = {};
    if (q) {
      try {
        body = JSON.parse(Buffer.from(q, "base64url").toString("utf8"));
      } catch {
        return c.json({ error: "q must be base64url-encoded JSON" }, 400);
      }
    }

    // Validate against the query interface BEFORE opening payment — an invalid request never charges.
    const planned = planQuery(config, body, policy);
    if (!planned.ok) return c.json({ error: planned.error.issues }, 400);
    const plan = planned.value; // hoist out of the generator closure (narrowing doesn't cross it)

    const gated = await charge(c.req.raw);
    if (gated.status === 402) return gated.challenge;

    // One row per yield → one unitPrice charged per row, committed just before the row is sent. The
    // agent that disconnects early stops the generator and stops paying.
    async function* rows(): AsyncGenerator<string> {
      const all = await engine.query(config, plan);
      for (const row of all) yield JSON.stringify(row);
    }

    return gated.withReceipt(rows());
  });

  // Session channel management for the stream (open / voucher / top-up / close). The client's SSE
  // driver POSTs these out-of-band to the same path (query stripped) — without this it hangs waiting
  // to open the channel. No content, no application charge; the session method consumes the
  // management credential and `withReceipt()` returns its response directly.
  app.post("/query/stream", async (c) => {
    const gated = await charge(c.req.raw);
    if (gated.status === 402) return gated.challenge;
    // SSE management responses must pass an explicit body (unlike the HTTP transport's no-arg
    // withReceipt()): a voucher/open/top-up/close post carries no content, so return a 204.
    return gated.withReceipt(new Response(null, { status: 204 }));
  });
}
