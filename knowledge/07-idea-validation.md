# 07 — Idea Validation: cheap public data → agents

**Question:** can we build infra to deliver public data to agents at the lowest possible cost over
MPP — without rebuilding what already exists?

Evidence base: live catalog `knowledge/raw/services.json` (95 services, fetched 2026-06-16 from
`https://mpp.dev/api/services`) + official proxy docs.

## What already exists (the landscape)

**95 live services.** Categories: data 49, ai 24, web 16, search 11, blockchain 10, social 8,
media 7, compute 5, storage 4. **~59 are data/search/blockchain** — i.e. the public-data space is
already crowded:

- **Financial/gov:** EDGAR (SEC), EDGAR Full-Text Search, Alpha Vantage, CoinGecko, Exchange Rates,
  VAT, IBAN Validation, GovLaws (US federal regs).
- **Geo/weather/travel:** Google Maps, Mapbox, OpenWeather, Timezone, Holidays, AviationStack,
  FlightAPI, GoFlightLabs, SerpApi (flights), RentCast (US real estate).
- **Web/search/scrape:** Brave Search, Tavily, Exa, Parallel, Perplexity, Firecrawl, Oxylabs,
  Diffbot (+KG), Web Scraping, BuiltWith, SpyFu, DripStack (Substack).
- **People/contact:** Apollo, Clado, Hunter, Company Enrichment, Email/Phone/IP Intelligence.
- **Onchain data:** Allium, Dune, Nansen, Codex, Alchemy, Conduit, Quicknode, Tempo RPC.
- **Knowledge/AI:** Wolfram|Alpha, Deepgram, DeepL, Tako, Diffbot KG.

**Pricing reality:** 93/95 use flat **`charge`** (per-request); 89/95 endpoints are dynamic-priced;
all settle on Tempo (pathUSD), 9 also offer Stripe/USD.

## The gap (where it's NOT crowded) ⭐

**Sessions are barely used — and never for public data.** Only **10/95** services offer the
`session` intent, and every one is an LLM API, blockchain RPC, or storage provider:

> Anthropic, OpenAI, Google Gemini, OpenRouter, Modal, Object Storage, Dune, Alchemy, Conduit, Tempo RPC

**Not a single one of the ~50 pure public-data feeds** (EDGAR, GovLaws, weather, FX, holidays,
flights, maps, real estate…) uses sessions. They all re-pay the chain on **every** request — the
expensive path (see [05](05-pricing-mechanics.md)). For an agent doing 10k lookups, that's 10k
on-chain txs vs ~2 with a session channel.

Two more white spaces:
- **No generic "dataset → MPP feed" framework.** Every service above is a bespoke integration. There
  is no infra that takes an arbitrary open dataset and emits a session-billed, per-row, gas-sponsored
  endpoint. (Tempo's wishlist explicitly asks for frameworks + hosted/no-code services — see [06](06-hackathon.md).)
- **No caching layer.** Public data is highly repeatable (same SEC filing, same weather tile). Nobody
  caches a paid-once query and re-serves it cheaper. Pay-once-per-unique-query is unbuilt.

## Don't-duplicate check

- **Official paid proxy exists** (`vendor/mpp/src/pages/sdk/typescript/proxy.mdx`,
  `guides/proxy-existing-service.mdx`): wraps ONE existing upstream behind a 402 **charge**. So a
  naïve "put 402 in front of an API" is already solved. Differentiation must come from
  **sessions + per-unit metering + caching + multi-source**, none of which the official proxy does.
- Bulk public-data wrappers exist → don't add yet-another single-API wrapper. Add the **layer**.

## Candidate framings (decision input — not yet committed)

| # | Framing | Already exists? | What's missing / the wedge | Simplest MVP |
|---|---|---|---|---|
| A | **Session-billed data-proxy framework** — `mppx`-based lib/CLI that wraps any HTTP/SQL/file dataset as a per-row, session-metered, `feePayer`-sponsored MPP endpoint + auto-`discovery()`. | Charge-only proxy exists; **no session proxy, no framework** | Sessions for public data + one-command setup | Wrap 1 open dataset (e.g. SEC EDGAR or data.gov) as `/query` billed $0.0001/row over a session; demo agent runs 1k queries on ~2 txs |
| B | **Cache/CDN in front of MPP data** — pay-once-per-unique-query; serve cached hits at a fraction (or free) to others, settle upstream once. | No | Cost collapse on repeatable public data | Caching reverse-proxy keyed on query hash; show cost drop vs uncached |
| C | **Aggregator/router over FREE open datasets not yet on MPP** — data.gov, World Bank, Eurostat, PubMed, OSM, GTFS… one MPP endpoint, agent pays only the thin session fee for delivery/normalization. | The specific datasets aren't on MPP; routers aren't either | Brings the open-data long tail onto MPP cheaply | Router exposing 2–3 free gov/sci datasets behind one session-billed MPP endpoint |

**Recommendation:** **A is the strongest infra bet** — directly on Tempo's wishlist (framework +
hosted), centered on the under-used session primitive, and B (caching) folds in as a feature. It is
"simple and effective," drives Tempo settlement volume, and is demonstrably *not* what the 95 live
services or the official proxy do. Validate next by reading `proxy.mdx` + `tempo.session` server API
in depth and prototyping the EDGAR/data.gov wrap.

## Open questions before building

- Does `mppx` session server API cleanly support **arbitrary per-row deltas** within one response, or
  is it one-voucher-per-HTTP-request? (Read `payment-methods/tempo/session.mdx` + `Ws.serve`/SSE.)
- Caching paid data — any licensing/ToS limits on re-serving upstream public data?
- Is "framework" or "hosted no-code" the better judged demo given time? (Lean framework + 1 live demo.)
