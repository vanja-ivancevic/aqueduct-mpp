/**
 * MPP service registry — discovery without hosting a directory of our own.
 *
 * Aqueduct holds NO central index. Discovery rides entirely on MPP's existing registry: a Tap is
 * published as a `Service` entry in MPP's `discovery.json` (served at `DISCOVERY_URL`), and agents
 * find Taps by reading that same public list. This file is the pure half: the entry we *render* for a
 * builder to publish, and the filter that picks our Taps back out of the full MPP list. The actual
 * HTTP fetch lives in `adapters/client` (this stays I/O-free, in `core`).
 *
 * We tag our entries `aqueduct` so the client can select Taps it knows how to drive (the constrained
 * `/schema` + `/query` contract) out of the ~80 unrelated data services in the registry.
 */
import type { TapConfig } from "./config";

/** The public MPP registry — `{ version, services: MppService[] }`. We read it; we never host it. */
export const DISCOVERY_URL = "https://mpp.dev/api/services";

/** Marker tag on our registry entries — how the client tells an Aqueduct Tap from any other service. */
export const AQUEDUCT_TAG = "aqueduct";

/** The subset of an MPP `Service` entry we author/read. Mirrors MPP's `schemas/services.ts`. */
export interface MppService {
  id: string;
  name: string;
  url: string;
  description?: string;
  categories?: string[];
  integration?: "first-party" | "third-party";
  tags?: string[];
  status?: "active" | "beta" | "deprecated" | "maintenance";
  methods: Record<string, { intents: string[]; assets?: string[] }>;
  realm?: string;
  endpoints: MppEndpoint[];
  provider?: { name?: string; url?: string };
}

export interface MppEndpoint {
  method: string;
  path: string;
  description?: string;
  payment?: {
    intent: string;
    method: string;
    currency?: string;
    recipient?: string;
    unitType?: string;
    dynamic?: true;
    amountHint?: string;
    description?: string;
  } | null;
}

/** A Tap distilled from the registry for an agent to choose from — just what's needed to decide + reach it. */
export interface TapEntry {
  id: string;
  name: string;
  url: string;
  description: string;
  price: string;
  currency: string;
}

/**
 * Render the MPP registry entry for a served Tap — every field derives from the frozen config plus the
 * URL the builder deploys at. The builder pastes this into a PR to `tempoxyz/mpp` (or their own
 * discovery doc). Pure + deterministic: same config + url → same entry.
 */
export function renderServiceEntry(
  config: TapConfig,
  opts: { url: string; description?: string; provider?: { name?: string; url?: string } },
): MppService {
  const base = opts.url.replace(/\/$/, "");
  const { unit, unitPrice, currency } = config.pricing;
  const description =
    opts.description ?? `${config.name} — agent-queryable per ${unit} via Aqueduct`;
  return {
    id: config.name,
    name: config.name,
    url: base,
    description,
    categories: ["data"],
    integration: "third-party",
    tags: [AQUEDUCT_TAG],
    status: "active",
    methods: { tempo: { intents: [config.mpp.intent], assets: [currency] } },
    realm: config.name,
    endpoints: [
      {
        method: "GET",
        path: "/schema",
        description: "free discovery — schema, query interface, price",
        payment: null,
      },
      {
        method: "GET",
        path: "/query",
        description: `paid — returns matching rows, billed per ${unit}`,
        payment: {
          intent: config.mpp.intent,
          method: "tempo",
          currency,
          recipient: config.mpp.recipient,
          unitType: unit,
          dynamic: true, // amount = rows × unitPrice, not a fixed per-call price
          amountHint: `${unitPrice}/${unit}`,
          description: config.pricing.unitDefinition,
        },
      },
    ],
    provider: opts.provider,
  };
}

/**
 * Pick the Aqueduct Taps out of a full MPP registry list, optionally narrowed by a free-text query
 * (substring match on name/description). Pure: discovery I/O happens in the caller. An entry counts as
 * a Tap if it carries our tag, or — as a fallback for entries published without it — exposes the
 * tell-tale free `GET /schema` + paid `GET /query` contract.
 */
export function selectTaps(services: MppService[], query?: string): TapEntry[] {
  const q = query?.trim().toLowerCase();
  return services
    .filter(isAqueductTap)
    .map(toTapEntry)
    .filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q));
}

function isAqueductTap(s: MppService): boolean {
  if (s.tags?.includes(AQUEDUCT_TAG)) return true;
  const hasFreeSchema = s.endpoints.some(
    (e) => e.method === "GET" && e.path === "/schema" && !e.payment,
  );
  const hasPaidQuery = s.endpoints.some(
    (e) => e.method === "GET" && e.path === "/query" && e.payment,
  );
  return hasFreeSchema && hasPaidQuery;
}

function toTapEntry(s: MppService): TapEntry {
  const query = s.endpoints.find((e) => e.path === "/query")?.payment;
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    description: s.description ?? "",
    price: query?.amountHint ?? "",
    currency: query?.currency ?? "",
  };
}
