# Market precedent: maintained data access is a proven, multi-billion-dollar business

The pitch question we kept circling: *"if the data is public, why would anyone pay for a Tap instead of
just fetching it (or having their agent fetch it)?"* The answer isn't a hypothesis — it's one of the
most validated business models in software. This doc is the precedent ammunition.

## The thesis, in one line

**Even when data is free and public, a maintained / normalized / fresh / pay-per-use access layer is a
big business** — because building and *babysitting* your own ingestion is fragmented, brittle, infra-
heavy, and never-ending. Customers (and increasingly agents) pay to never touch that treadmill.

## The killer precedent: crypto data infra (our exact ecosystem)

The blockchain is **100% public and free to read.** Yet a multi-billion-dollar industry monetizes
*maintained access* to it — in the same crypto ecosystem as Tempo/MPP:

| Company | What it sells | Scale |
|---|---|---|
| **Alchemy** | "don't run your own node" — RPC + dev APIs | **$10.2B** valuation (2022) |
| **Infura / Consensys** | node/RPC access | Consensys ~**$7B** (2022); 2026 IPO targeting $10B+ |
| **The Graph** | "don't build your own indexer" — indexed chain data via GraphQL | billions of queries served |
| **Dune** | "don't ETL the chain yourself" — SQL on-chain analytics | **$1B** (2022) |
| **Nansen** | labeled / enriched on-chain intelligence | **$750M** (2022) |

"Don't run your own node / don't build your own indexer" *is* "don't build your own ingestion pipeline."
This is Aqueduct's pitch, already a multi-billion-dollar reality, and it directly kills the "but the
data is public" objection.

## The cleanest mental model: SerpAPI + the scraping economy

Google search results are **maximally public and free.** Yet **SerpAPI** and the web-scraping-as-a-
service market (**Bright Data ~$960M**, Apify, Zyte, Oxylabs, ScraperAPI) exist purely because
self-maintaining the access layer is brittle, adversarial, and never-ending. People pay *per query* to
offload it. The web-scraping-services market is **~$1.0B (2025) → ~$2.2B (2031), ~14% CAGR.**

This is exactly our USGS / NASA / exoplanet story: the data is public, but maintained, normalized, fresh
access is worth paying for — and nobody should babysit a scraper for production any more than they'd run
their own Ethereum node.

## The build-vs-buy value drivers (what makes customers pay), mapped to Aqueduct

| Driver | Precedent | Aqueduct equivalent |
|---|---|---|
| **Brittle to collect** | SerpAPI — scrapers break on layout/blocks | builder refresh pipelines (`scripts/refresh-*.ts`) |
| **Infra-heavy** | Alchemy — node ops | serving + freshness window, $0-LLM hot path |
| **Fragmented** | Plaid — 12,000 bank integrations (~$8B) | discovery + per-Tap aggregation |
| **Needs normalization** | Bloomberg — $10–13B/yr Terminal | LLM-compiled onboarding → clean schema |
| **Needs canonical / fresh / licensed** | Polygon, market-data vendors | determinism + enforced freshness window |

## Who actually buys (end-user segments, mapped to real customers)

- **Devs / startups building a product** that needs data X — the Plaid / SerpAPI customer. Won't build
  and own ingestion for a feature.
- **Autonomous agents** — structurally can't maintain infra; can only buy per-call.
- **Quants / analysts** needing occasional or long-tail data — not worth a bespoke pipeline.
- **Apps needing freshness / SLA / canonical data** — outsource the keep-it-current burden.

## The agent-economy validation is real *now* (not hypothetical)

The piece that makes Aqueduct timely: agents are starting to pay per call on HTTP-402 rails — the same
primitive as MPP.

- **x402** (Coinbase's 402-native stablecoin protocol): by early 2026, **~165M agent transactions,
  ~$50M volume**; payments over $1 went from **~49% → ~95% of value** (real API consumption, not test
  txns). Agents pay per-call with **no API keys** — the payment authorizes the request.
- **Institutional backing:** x402 Foundation under the **Linux Foundation**, with **Stripe, AWS, Google,
  Shopify, Visa, Mastercard.** AWS Bedrock AgentCore and Stripe support it. Alpha Vantage ships an
  official MCP server; Coinbase launched Agent.market.

This is precisely Aqueduct/MPP's model — per-query, keyless, wallet-settled — becoming real this year.

## The honest bet: what's proven vs what's novel

- **Proven, overwhelmingly:** maintained access to otherwise-available data is a huge business (crypto
  infra, SerpAPI/scraping, Bloomberg, Plaid).
- **Aqueduct's novel bet** = stitching two halves no one has proven *together* at scale:
  1. the **long tail** of arbitrary datasets (vs Alchemy/Bloomberg's few high-value sources), made
     economical by **LLM-compiled onboarding** — the LLM does the one-time normalization a human data
     team would otherwise have to fund per dataset; and
  2. **agent-native micropayments** as the buyer + rail (x402 / MPP).
  Each half is proven separately. Combining them is the wager — and x402's traction says the timing is
  right. The incumbents (Bloomberg, Plaid) can't chase the long tail (human GTM, enterprise contracts,
  $15k/yr minimums); the long tail is only reachable when onboarding is ~free and settlement is per-call.

## Positioning (the one-liner)

> **Aqueduct is Stripe for data → agents.** One command turns any dataset into an agent-payable,
> discoverable API; one skill lets any agent buy from any Tap. DuckDB + MPP are the engine; the
> **standard interface** is the product.

## Honest defensibility (where the value really is — and isn't)

A clear-eyed reading, because the core *is* thin:

- **What's actually here:** an LLM **compiler** (any messy file → typed, validated, eval-passed config),
  a thin **runtime** (DuckDB serves the file · a constrained query interface prevents raw SQL · MPP
  meters + settles), and a **standard** (uniform discovery + query so one skill/MCP consumes any Tap).
  The runtime is glue; the compiler and the standard are the differentiated parts, and neither is deep.

- **The honest critique (own it):** a *sophisticated data vendor* who already runs the hard pipeline +
  an API will **not** use Aqueduct — they `npm install mppx`, add it to their existing API, and we're
  redundant. The more capable the builder, the less we add. If the hard part is the pipeline and the
  builder owns the pipeline, we only own the easy part.

- **So who is it for?** Not SerpAPI/Bloomberg (they have their own everything). Two segments:
  1. **The long-tail data owner who is *not* a data company** — has a useful CSV/parquet, will never
     hand-build a query API + payment integration + rate limiting + discovery. For them Aqueduct is the
     *whole stack*, in one command.
  2. **The agent (demand side)** — if every builder rolls a bespoke API, agents face N interfaces.
     Aqueduct standardizes query + discovery so one skill buys from any Tap. Value accrues to the
     consumer, as a network.

- **The precedent for "thin wrapper, huge product":** Stripe is "just an API over Visa." Vercel is "just
  a wrapper over AWS." Shopify, Twilio, MCP — all thin over something that existed. The wrapper *is* the
  product because the value is **DX + standardization + network**, not the underlying tech. "A builder
  could integrate Visa/MPP directly" is true and irrelevant; almost nobody does.

- **The caveat we hold:** defensibility is therefore **adoption / network, not technology.** The tech is
  replicable in a weekend. If Aqueduct wins it's because it became *the* standard way to publish and
  consume agent-payable data — the way MCP won, not the way an algorithm wins. For a hackathon you can
  demonstrate the DX + the standard working end-to-end (`scripts/showcase.ts`); you cannot *prove* a
  network effect. That's the honest bet.

## Honest caveats (don't oversell)

- **High-ticket incumbents (Bloomberg, FactSet, ZoomInfo, Plaid) prove "access is valuable," not the
  micropayment / self-serve / long-tail model.** Their moat is proprietary data + enterprise GTM, not
  metered access to public files. Cite them for the *category*, not the exact shape.
- **The single-shot, single-user fetch is still a wash** (see `knowledge/16`, `17`): the precedent
  applies to *production / recurring / multi-consumer* use, where build-vs-buy tips — not to a lone
  one-off question.
- **The agent-native + long-tail combination is unproven at scale.** That's the opportunity, and the
  risk. x402 is strong directional evidence, not a revenue precedent yet.

### Sources

- Crypto infra valuations: TechCrunch/Fortune (Alchemy $10.2B Series C1); Consensys raise coverage;
  Dune / Nansen round announcements (2022).
- SerpAPI / scraping market: Sacra/Growjo estimates; Mordor Intelligence (web-scraping-services market);
  CTech (Bright Data).
- Plaid: https://sacra.com/c/plaid/ · Bloomberg / financial-data market: industry reporting (~$50B).
- x402 agentic payments: https://www.chainalysis.com/blog/x402-agentic-payments-adoption/ ;
  Coinbase x402 coverage.
