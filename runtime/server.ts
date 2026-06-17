/**
 * Tap server — wraps the deterministic query path behind an MPP per-query session charge.
 *
 * Billing model (MVP, no SSE): compute the billable row count for the request, price it
 * `returned × unitPrice`, gate the request with a Tempo session charge, then serve the rows with a
 * receipt. The LLM is nowhere near this path; it's config execution + payment only.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { Mppx, tempo } from "mppx/server";
import { http, type Account, createClient } from "viem";
import { tempoModerato } from "viem/chains";
import type { DuckDbEngine } from "../adapters/source/duckdb";
import type { ValidatedConfig } from "../core/config";
import { DEFAULT_RPC_URL } from "../core/constants";
import { unitsCost } from "../core/pricing";
import { planQuery, queryPolicy } from "../core/query";
import { type RowCache, cacheKey, memoryCache, parseDurationMs } from "./cache";

/** Gas the fee-payer will sponsor, in wei. The default mppx policy caps maxFeePerGas at 100 gwei and
 *  maxPriorityFeePerGas at 50 gwei — both below live Moderato gas — so sponsored channel opens fail.
 *  Lift them to a testnet-safe ceiling. Operators tune per network. */
const DEFAULT_SPONSOR_MAX_FEE_PER_GAS = 1_000_000_000_000n; // 1000 gwei
const DEFAULT_SPONSOR_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000_000n; // 1000 gwei

/** Ceiling on the raw `?q=` string before base64url-decode (the planner bounds the parsed request). */
const MAX_Q_CHARS = 256_000;

/** Channel deposit (in the settlement token) the server suggests a client open — sized to cover a
 *  whole session so no mid-session top-up is ever needed. Operators tune to expected session spend. */
const DEFAULT_SUGGESTED_DEPOSIT = "0.10";

export type TapServerOptions = {
  /** Server wallet: receives settlement. */
  account: Account;
  rpcUrl?: string;
  /**
   * Gas sponsor. A DISTINCT funded wallet (≠ `account`) that pays agents' on-chain channel gas. Must
   * differ from `account`: Tempo rejects a sponsored tx whose fee-payer equals the sender, so
   * `feePayer:true` (sponsor == settlement account) can't settle. Omit → agents self-pay gas.
   */
  sponsorAccount?: Account;
  /** Query-result cache. Defaults to an in-memory TTL cache keyed on `config.cache.ttl`. */
  cache?: RowCache;
  /** Max gas price (wei) the sponsor will cover for on-chain channel ops. */
  sponsorMaxFeePerGas?: bigint;
  /** Channel deposit (settlement-token decimal) the server suggests clients open. */
  suggestedDeposit?: string;
  realm?: string;
  /**
   * MPP challenge-signing secret. Omit and a fresh random secret is generated per process — safe, but
   * NOT stable across restarts/instances. Set it explicitly to keep challenges verifiable across
   * restarts or behind a shared session store. There is no static default (never a shared "dev" key).
   */
  secretKey?: string;
};

// Only an eval-passed `ValidatedConfig` can be served (the brand makes "served un-evaluated" a type
// error). The caller obtains one from the eval gate (`validate`), never by hand.
export function createTapServer(
  config: ValidatedConfig,
  engine: DuckDbEngine,
  opts: TapServerOptions,
): Hono {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
  // The combined `tempo()` method registers both the charge (bootstrap) and session intents the
  // client's session manager drives across its channel lifecycle (open / voucher / top-up / close).
  // Currency + feePayer live on the method; per-route we only vary `amount` (and the payout).
  // `feePayerPolicy` lifts the sponsored-gas cap so on-chain channel opens clear current testnet gas.
  const mppx = Mppx.create({
    methods: [
      tempo({
        account: opts.account,
        currency: config.mpp.currency,
        // Sponsor agents' gas ONLY when the config asks for it AND a distinct sponsor wallet exists.
        // Bare `feePayer: true` makes the sponsor == the settlement account, which Tempo rejects on
        // settle ("fee payer cannot resolve to sender") — so we never emit it; no sponsor → self-pay.
        feePayer: config.mpp.feePayer && opts.sponsorAccount ? opts.sponsorAccount : undefined,
        feePayerPolicy: {
          maxFeePerGas: opts.sponsorMaxFeePerGas ?? DEFAULT_SPONSOR_MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: DEFAULT_SPONSOR_MAX_PRIORITY_FEE_PER_GAS,
        },
        testnet: true,
        getClient() {
          return createClient({ chain: tempoModerato, transport: http(rpcUrl) });
        },
      }),
    ],
    realm: opts.realm ?? "aqueduct",
    // No static fallback — a shared default secret would let anyone forge challenges. A random
    // per-process key is safe; operators set `secretKey` (CLI: AQUEDUCT_SECRET) for stability.
    secretKey: opts.secretKey ?? randomBytes(32).toString("hex"),
  });

  const cache = opts.cache ?? memoryCache(parseDurationMs(config.cache.ttl));
  // Namespace cache keys to this Tap+source so a shared/injected cache can't cross datasets.
  const cacheNs = `${config.name}:${config.source.location.ref}`;
  // Compile the config's query interface once — planQuery reuses it on every request (hot-path law).
  const policy = queryPolicy(config);

  const app = new Hono();

  // Free, unpaid discovery — agents read terms before paying.
  app.get("/schema", (c) =>
    c.json({
      name: config.name,
      schema: config.schema,
      query: config.query,
      pricing: config.pricing,
    }),
  );

  // Per-request charge; currency/feePayer come from the method, only `amount` + payout vary here.
  // `suggestedDeposit` sizes the channel the client opens. Advertising enough to cover a whole
  // session means the client never needs a mid-session top-up (a client-funded on-chain deposit that
  // mppx can't retry — it hard-throws on the 402), so multi-request runs on one channel + one settle.
  const suggestedDeposit = opts.suggestedDeposit ?? DEFAULT_SUGGESTED_DEPOSIT;
  const charge = (amount: string) =>
    mppx.session({
      amount,
      unitType: config.pricing.unit,
      recipient: config.mpp.recipient,
      suggestedDeposit,
    });

  // GET /query?q=<base64url JSON request> — the paid content path. We use GET so the MPP session
  // manager's channel-lifecycle POSTs (open/top-up/close, which target this same URL) are
  // unambiguously separable from a data request. The agent request rides in `q`.
  app.get("/query", async (c) => {
    const q = c.req.query("q");
    // Bound the request before decoding — the planner's per-field caps bound the *parsed* request,
    // but we must not decode/parse an arbitrarily large `q` in the first place.
    if (q && q.length > MAX_Q_CHARS) {
      return c.json({ error: `q exceeds ${MAX_Q_CHARS} chars` }, 400);
    }
    let body: unknown = {};
    if (q) {
      try {
        body = JSON.parse(Buffer.from(q, "base64url").toString("utf8"));
      } catch {
        return c.json({ error: "q must be base64url-encoded JSON" }, 400);
      }
    }

    const planned = planQuery(config, body, policy);
    if (!planned.ok) return c.json({ error: planned.error.issues }, 400);

    const key = cacheKey(planned.value, cacheNs);
    const cached = cache.get(key);

    // Cache hit: rows (already limited) are known, so is the billable count — no DuckDB, no COUNT.
    // Cache miss: a cheap COUNT prices the request; the full SELECT runs only after payment clears.
    // Engine calls are wrapped so adversarial-but-valid input that trips DuckDB returns 502, not a
    // 500 with a stack — and never after a charge (count is pre-charge; serve is post-charge).
    let returned: number;
    try {
      returned = cached ? cached.length : await engine.countMatching(config, planned.value);
    } catch {
      return c.json({ error: "query could not be evaluated against the source" }, 502);
    }

    // No rows → no value delivered → no charge. Cache the empty result so a repeated zero-row query
    // (e.g. offset past the end) can't force an unpaid COUNT every time.
    if (returned === 0) {
      if (!cached) cache.set(key, []);
      return c.json({ rows: [], count: 0, amount: "0", cached: Boolean(cached) });
    }

    const amount = unitsCost(config.pricing.unitPrice, returned);
    const gated = await charge(amount)(c.req.raw);
    if (gated.status === 402) return gated.challenge;

    let rows: Record<string, unknown>[];
    try {
      rows = cached ?? (await engine.query(config, planned.value));
    } catch {
      // Charge cleared but the SELECT failed. countMatching already succeeded on the same plan, so
      // this is rare; surface 502 rather than silently 500. (Refund-on-failure is roadmap.)
      return c.json({ error: "query failed after payment; contact operator" }, 502);
    }
    if (!cached) cache.set(key, rows);
    return gated.withReceipt(
      Response.json({ rows, count: rows.length, amount, cached: Boolean(cached) }),
    );
  });

  // POST /query — MPP session channel lifecycle (open / top-up / voucher / close). No content, no
  // application charge; the session method consumes the management credential and `withReceipt()`
  // returns its response directly.
  app.post("/query", async (c) => {
    const gated = await charge(config.pricing.unitPrice)(c.req.raw);
    if (gated.status === 402) return gated.challenge;
    return gated.withReceipt();
  });

  return app;
}
