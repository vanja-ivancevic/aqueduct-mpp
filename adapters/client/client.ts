/**
 * Aqueduct consumption client — the three read ops an agent uses to find, inspect, and buy from a Tap.
 * One thin layer over (1) MPP's public registry for discovery and (2) the Tap's own HTTP+402 surface.
 * The skill and the MCP server are both just transports over this — keep the logic here, once.
 *
 * The wallet stays agent-side: `buyRows` pays with the caller's key over an MPP session (non-custodial,
 * invariant 5). There is no shared/hosted payer — a central one would hold funds and break that.
 */
import { tempo } from "mppx/client";
import { http, createClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { DEFAULT_RPC_URL } from "../../core/constants";
import { DISCOVERY_URL, type MppService, type TapEntry, selectTaps } from "../../core/registry";

/** Find Aqueduct Taps in MPP's public registry, optionally narrowed by free text. Free, no wallet. */
export async function discover(
  query?: string,
  opts: { registryUrl?: string } = {},
): Promise<TapEntry[]> {
  const res = await fetch(opts.registryUrl ?? DISCOVERY_URL);
  if (!res.ok) throw new Error(`registry ${res.status} from ${opts.registryUrl ?? DISCOVERY_URL}`);
  const body = (await res.json()) as { services?: MppService[] };
  return selectTaps(body.services ?? [], query);
}

/** Read a Tap's terms — schema, query interface, price. Free, no wallet. */
export async function fetchSchema(tapUrl: string): Promise<unknown> {
  const res = await fetch(`${base(tapUrl)}/schema`);
  if (!res.ok) throw new Error(`/schema returned ${res.status}`);
  return res.json();
}

export interface BuyResult {
  count: number;
  amount: string;
  cached: boolean;
  settlement: string | null;
  rows: Record<string, unknown>[];
}

/**
 * Buy exactly the rows a constrained request selects: opens an MPP session, pays `rows × unitPrice`,
 * settles on close. One targeted query per call (single on-chain settle). The request is abstract data
 * validated server-side against the query interface — never SQL.
 */
export async function buyRows(
  tapUrl: string,
  request: unknown,
  opts: { key: string; rpcUrl?: string; maxDeposit?: string },
): Promise<BuyResult> {
  if (!opts.key.startsWith("0x")) throw new Error("key must be a 0x-prefixed funded agent key");
  const account = privateKeyToAccount(opts.key as `0x${string}`);
  const rpc = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const getClient = () => createClient({ chain: tempoModerato, transport: http(rpc) });

  // Re-wrap responses so the session manager can attach receipt/cumulative (204/304 carry no body).
  const extensibleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await fetch(input, init);
    const nullBody = r.status === 204 || r.status === 304;
    return new Response(nullBody ? null : await r.arrayBuffer(), {
      status: r.status,
      headers: r.headers,
    });
  }) as typeof fetch;

  const session = tempo.session.manager({
    account,
    getClient,
    maxDeposit: opts.maxDeposit ?? "1",
    fetch: extensibleFetch,
  });

  const q = Buffer.from(JSON.stringify(request)).toString("base64url");
  const res = (await session.fetch(`${base(tapUrl)}/query?q=${q}`, { method: "GET" })) as Response;
  if (res.status !== 200) throw new Error(`query returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as Omit<BuyResult, "settlement">;

  const receipt = (await session.close()) as { reference?: string } | undefined;
  return {
    count: body.count,
    amount: body.amount,
    cached: body.cached,
    settlement: receipt?.reference ?? null,
    rows: body.rows,
  };
}

export interface StreamRow {
  /** the row */
  row: Record<string, unknown>;
  /** 1-based index of this row in the stream */
  index: number;
}

/**
 * Stream rows from a Tap's experimental `GET /query/stream`, paying one unitPrice per row as it
 * arrives (MPP SSE metering). Yields each row; the caller can `break` to stop the stream — and stop
 * paying — after any row. Settles the cumulative voucher on close. The optional `onReceipt` fires for
 * each receipt the stream emits (per-row and the final settlement).
 */
export async function* streamRows(
  tapUrl: string,
  request: unknown,
  opts: {
    key: string;
    rpcUrl?: string;
    maxDeposit?: string;
    onReceipt?: (r: unknown) => void;
    onClose?: (err: Error | null, receipt?: unknown) => void;
  },
): AsyncGenerator<StreamRow> {
  if (!opts.key.startsWith("0x")) throw new Error("key must be a 0x-prefixed funded agent key");
  const account = privateKeyToAccount(opts.key as `0x${string}`);
  const rpc = opts.rpcUrl ?? DEFAULT_RPC_URL;
  const getClient = () => createClient({ chain: tempoModerato, transport: http(rpc) });

  // The session manager does `Object.assign` on the response, so it must be extensible (a live fetch
  // Response is frozen). Re-wrap — but for SSE we must PASS THE STREAMING BODY THROUGH, never buffer:
  // `arrayBuffer()` on an event-stream that stays open would hang forever (the JSON path can buffer; a
  // stream cannot). Null-body statuses (management 204/304) carry no body.
  const extensibleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await fetch(input, init);
    const nullBody = r.status === 204 || r.status === 304;
    return new Response(nullBody ? null : r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;

  const session = tempo.session.manager({
    account,
    getClient,
    maxDeposit: opts.maxDeposit ?? "1",
    fetch: extensibleFetch,
  });

  // Report the session outcome at most once (a stream-read error and the close can both fail).
  let reported = false;
  const toErr = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const report = (err: Error | null, receipt?: unknown) => {
    if (reported) return;
    reported = true;
    opts.onClose?.(err, receipt);
  };

  // Request rides in a header (not the URL query) so the channel-voucher POSTs the SSE driver sends to
  // this same path aren't misclassified as billable content by MPP — see runtime/stream.ts.
  const q = Buffer.from(JSON.stringify(request)).toString("base64url");
  try {
    const stream = await session.sse(`${base(tapUrl)}/query/stream`, {
      onReceipt: opts.onReceipt,
      headers: { "x-aqueduct-query": q },
    });
    let index = 0;
    for await (const data of stream) {
      index += 1;
      yield { row: JSON.parse(data) as Record<string, unknown>, index };
    }
  } catch (e) {
    // EXPERIMENTAL: the per-row delivery + metering work, but if the MPP SSE layer aborts the stream
    // (the open multi-tick voucher-reconciliation issue), surface it via onClose rather than throwing
    // through the caller's for-await — the rows already yielded are real and kept.
    report(toErr(e));
    return;
  } finally {
    // Close even on early break — settles exactly what was consumed (non-custodial, peer-to-peer).
    try {
      const receipt = await session.close();
      report(null, receipt);
    } catch (e) {
      report(toErr(e));
    }
  }
}

const base = (url: string) => url.replace(/\/$/, "");
