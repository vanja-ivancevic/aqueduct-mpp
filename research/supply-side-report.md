# The Economics of AI-Crawler Load on Long-Tail Open-Data Providers, and the Viability of Programmatic Micropayments as a Structural Sustainability Layer

> Deep-research output (compiled from hundreds of sources) answering `research/deep-research-question.md`.
> Read alongside the four candidate deep-dives below. The load-bearing takeaway for Aqueduct is the
> **mirror trap** (see Adversarial Verdict): micropayments for *static, easily-mirrored* public-domain
> data fail; value must be *service* (availability / freshness / compute), per the Alchemy precedent.

---

The rapid rise of large language models (LLMs) and the subsequent deployment of real-time retrieval-augmented generation (RAG) agents have transformed the open web's resource economics. Historically, the relationship between automated web crawlers and content providers rested on a mutually beneficial arrangement: crawlers indexed web pages to direct referral traffic back to the source. However, modern AI scraping models operate under an extraction-only paradigm. They ingest vast corpuses of high-fidelity open data to train offline commercial neural networks or answer user queries directly within conversational interfaces, sending virtually no referral traffic back to the origin.

This asymmetric resource extraction has triggered an operational and financial crisis for small and mid-sized open-data providers. These digital commons — scientific databases, biodiversity catalogs, open-access libraries, civic mapping networks, and free software repositories — are highly vulnerable to these sudden shifts in traffic. Operating on inelastic, non-profit, or grant-funded budgets, these providers are facing unsustainable increases in server load, bandwidth costs, and engineering overhead. This analysis examines the scale of this structural crisis and evaluates whether an automated, HTTP 402-style micropayment layer settled in stablecoins can function as a viable sustainability mechanism.

## Magnitude of the Automated Crawler Load

The operational strain on long-tail open-data providers has shifted from an occasional nuisance in server logs to a threat to platform stability. Modern AI crawlers utilize parallelized scraping routines that recursively traverse databases. This activity frequently acts as a distributed denial-of-service (DDoS) attack.

```
                     TRAFFIC PATTERN CONTRAST
                     ========================

    TRADITIONAL HUMAN PATTERNS           MODERN AI SCRAPER PATTERNS
    --------------------------           --------------------------
    * Hits popular/cached paths.         * Systematically crawls entire origin.
    * Low parallel concurrency.          * High parallel concurrency.
    * Follows regional cache routes.     * Bypasses regional edge caching.
    * Highly predictable bursts.         * Unpredictable, high-volume spikes.
```

Because these scraping routines systematically request uncached pages, historical revisions, and raw database dumps, they bypass regional content delivery network (CDN) caches. This forces origin servers to execute expensive database queries and generate dynamic responses, consuming substantial compute resources.

Documented incidents across diverse open-data ecosystems:

- **DiscoverLife:** In early 2025, this biodiversity and taxonomic database — which hosts nearly 3 million species photographs — experienced millions of daily hits from highly adaptive, parallelized AI crawlers. These bots continuously refined their extraction patterns, exhausting origin CPU capacity and rendering the site completely inaccessible to the global scientific community.
- **Read the Docs:** In May 2024, a single misconfigured AI training crawler downloaded 73 terabytes of zipped HTML documentation files within a single month. This single incident consumed nearly 10 terabytes in a single day, generating over $5,000 in immediate bandwidth charges. When operators blocked this traffic, platform bandwidth requirements plummeted by 75%, dropping from 800 GB/day to 200 GB/day.
- **Zenodo:** Maintained by CERN and funded by the European Commission, Zenodo experienced a surge in covert, high-frequency harvesting targeting its search endpoints in late 2025. Automated scrapers executed up to 500 requests per second, overwhelming the Elasticsearch/OpenSearch index and forcing operators to implement strict records-search API rate limits.
- **Directory of Open Access Journals (DOAJ):** In the second half of 2025, DOAJ saw a 419% increase in automated traffic compared to the previous year. This culminated in a single-day spike of 968% in mid-November 2025, which disrupted editorial indexing workflows and forced a costly migration to dynamic, background-generated static citation layers to protect the underlying API.
- **Wikimedia Foundation:** Since the acceleration of generative AI training in 2024, Wikimedia has faced a 50% YoY increase in multimedia download bandwidth. More critically, bots generate over 65% of the most expensive traffic hitting Wikimedia's central data centers. While human readers request highly popular, globally cached articles, scrapers systematically request obscure, historical, and un-cached entries, forcing expensive database queries at the primary Ashburn data center.
- **OpenStreetMap (OSM):** In February 2026, OSM's standard raster tile and geocoding services (Nominatim and Overpass) faced severe service disruptions from anonymous scraping networks routing requests through more than 100,000 distinct IP addresses. This distributed traffic bypassed standard edge blocking rules and forced the deployment of raw IP-based throttling.
- **VizieR / CDS Strasbourg:** Operated by the Centre de Données astronomiques de Strasbourg, VizieR hosts massive astronomical literature catalogs. In late 2025, automated scraping of raw catalog tables bypassed optimized cross-match services, forcing the team to implement strict table download caps and gate bulk metadata access behind API authentication.
- **SourceHut and GNU Savannah:** Scrapers recursively crawl CPU-intensive git-blame, raw commit logs, and historical diff views. SourceHut responded by unilaterally blocking major cloud subnets (GCP/Azure) and deploying cryptographic proof-of-work challenges. FSF's GNU Savannah has suffered git outages and persistent 429 rate-limiting failures on packaging endpoints.
- **Perseus Digital Library:** Tufts University's classical literature repository experienced recurrent 503 errors in mid-2025, caused by overseas bot swarms recursively crawling ancient Greek and Latin text catalogs.

## Financial and Philosophical Barriers to Enterprise Defense

The entities bearing these costs are fundamentally unequipped to absorb them. Funding models are inelastic — small academic teams, grant-funded bodies, volunteer non-profits, university libraries — under strict annual budget constraints. An unexpected $5,000 monthly bandwidth surcharge or the need to hire dedicated SREs can quickly deplete annual operating reserves.

```
+--------------------------------------------------------------------------+
|                  ENTERPRISE DEFENSIVE STACK OBSTACLES                     |
+--------------------------------------------------------------------------+
|  FINANCIAL ROADBLOCK:                                                     |
|  * Subscription costs for top-tier WAFs (e.g., Cloudflare Enterprise,     |
|    Fastly, DataDome) exceed entire annual IT budgets.                     |
+--------------------------------------------------------------------------+
|  PHILOSOPHICAL CONFLICT:                                                  |
|  * Proprietary challenge screens (e.g., CAPTCHAs, cookie walls) violate   |
|    open-access mandates, locking out legitimate assistive technologies,   |
|    non-profit aggregators, and academic research scripts.                 |
+--------------------------------------------------------------------------+
```

Commercial bot-mitigation tools rely on proprietary browser fingerprinting, TLS JA3/JA4 signatures, and intrusive behavioral tracking — a major philosophical conflict for platforms committed to user privacy, open-source stacks, and minimal tracking. Consequently, these platforms are often forced to choose between running unprotected origin servers or implementing blunt blocklists that shut out legitimate users.

## Inadequacy of Existing Defenses

- **robots.txt / llms.txt:** Entirely non-binding. A long tail of unverified scrapers and commercial competitors systematically ignore them. Many real-time search assistants bypass them entirely, arguing they crawl "on behalf of a specific user query" rather than for bulk training.
- **User-Agent / IP blocking:** Rendered obsolete by residential proxy networks (e.g. botnets routing through millions of compromised Android TV boxes and home routers). To a WAF this traffic is indistinguishable from human residential users; blocking it causes severe collateral damage. Scrapers also hijack trusted cloud proxies (Google Translate, Facebook link-preview) to scrape from Google/Meta IP space.
- **Rate throttling / CAPTCHAs:** Per-IP limits fail when a scrape is distributed across 100,000 IPs each making 1–2 queries. CAPTCHAs / Turnstile destroy openness — when Fandom added strict login gates it saw a 40% drop in new contributions.
- **Cryptographic Proof-of-Work (Anubis):** Deployed by Codeberg, OAPEN, SourceHut. Blocks simple scripts, but: (a) **Solver asymmetry** — operators compile native WASM/Rust SHA-256 solvers far faster than a human's JS execution (Codeberg reported successful bypass Aug 2025); (b) **User tax** — high CPU/battery penalty on legitimate users with older mobile devices.
- **Cloudflare Pay-Per-Crawl:** Launched closed beta July 2025, co-launched with Stack Overflow early 2026. WAF issues HTTP 402; crawler must present payment credentials. Early testing cut unauthorized bot traffic 32% and raised data-licensing revenue 27%. Drawbacks: **platform lock-in** (Cloudflare is exclusive merchant of record, sets the pricing floor, takes a fee) and **exclusion of independent operators** (sovereign self-hosted platforms that refuse to route through a single dominant US security provider).

## Comprehensive Evidence Base of Provider Incidents

Twenty incidents across global open-data, scientific, and cultural-heritage providers.

| Provider / Operator | Core Data Domain | Data License | Funding / Operating Model | Documented Traffic / Financial Impact | Deployed Defenses | Plausibility of Adopting Programmatic Paid Access |
|---|---|---|---|---|---|---|
| DiscoverLife | Biodiversity image directory | CC BY-SA | Grants & academic sponsors | Millions of daily hits Feb 2025; site slowed to total unresponsiveness | Manual blocking & CDN rate-limiting | **High** — constrained academic budget; severe pain forces adoption |
| Read the Docs | FOSS software manuals | CC BY-SA / FOSS | Corporate sponsorship & credits | One crawler downloaded 73 TB May 2024; ~$5,000 bandwidth spike | CDN reconfig, temp Cloudflare AI-bot blocks | **High** — standardized high-volume requests align with API billing |
| DOAJ | Academic journal metadata | CC BY-SA (metadata) | University & library consortia | 419% spike H2 2025; single-day 968% Nov 2025; editorial ops halted | Expanded capacity, async static citation, selective WAF | **Moderate** — strong OA philosophy resists gating, but costs force pragmatism |
| Zenodo | Scientific repository | CC0 / CC BY / multi | EU Commission & CERN | Covert search-API harvesting up to 500 req/s late 2025 | Rate limit 30 req/min; capped anon search at 25 | **Low** — funded to maintain zero-cost open science; licensing prevents gating |
| Wikimedia Foundation | Encyclopedic metadata & media | CC BY-SA / GFDL | Public donations & endowment | 50% YoY multimedia bandwidth surge 2024; bots = 65% of expensive traffic | Wikimedia Enterprise commercial APIs, RocksDB caching | **Already active** — Enterprise monetizes big tech; long-tail micro still speculative |
| OpenStreetMap | Geospatial vector tiles | ODbL | Foundation donations & sponsors | Feb 2026 disruption; 100,000+ distinct scraper IPs | IP/user-agent/referer checks via Fastly WAF | **High** — transactional tile/search services integrate API billing easily |
| VizieR / CDS Strasbourg | Astronomical catalogs | CC0 / academic use | French National Fund for Open Science | Bulk extraction bypasses cross-match; query queues for researchers | Capped uploads 100 MB, query matches 2M rows | **Moderate** — FAIR-committed but severely compute-constrained |
| SourceHut | Git forges / FOSS code | FOSS (GPL/AGPL) | User subscription | Heavy scraping of compute-heavy endpoints (git-blame, raw logs) | Anubis PoW; blocked GCP/Azure subnets | **High** — developer-centric; users familiar with crypto payments |
| GNU Savannah | FOSS infrastructure | GPL / FOSS | Free Software Foundation | Persistent git outages & 429s on packaging servers early 2025 | UA poisoning, manual IP bans, mirror redirection | **Low** — FSF ideological opposition makes payments/auth a non-starter |
| Perseus Digital Library | Classical literature | CC BY-NC-SA | Tufts University & grants | Recurrent 503s June 2025 from overseas scraping loops | Host firewall IP blocks; university security coordination | **Moderate** — tiny non-technical team can't support billing stacks |
| UNC Chapel Hill Libraries | Academic catalog | Public domain | State university budget | Catalog outages 2024; single-day 11,329 heavy facet queries | Facet detection, WAF, Fail2ban progressive banning | **Moderate** — state procurement / public-records friction |
| OAPEN Library | Open-access books | CC BY-NC-ND | Foundation & library fees | Bot traffic 60–80% of total hits late 2025 | Cloudflare WAF, rate limiting, Anubis PoW | **High** — already forced into aggressive access controls |
| Directory of Open Access Books (DOAB) | Monograph indexing | CC BY | Joint foundation (OAPEN/OpenEdition) | Stability degradation under vuln scans & metadata harvests | Cloudflare filtering, login-incentivized bypass | **Moderate** — metadata valuable for indexing; API monetization aligns |
| MusicBrainz | Music metadata | CC0 / CC-BY-NC-SA | MetaBrainz Foundation donations | Continuous automated tagger-API requests degrade performance | Throttled anon UAs; 1 req/s/IP; global 300 rps cap | **High** — already charges commercial users for dumps |
| Open Food Facts | Product specifications | ODbL | Public association / crowdfunded | High search-as-you-type API load on central relational servers | 15 req/min reads; 10 req/min search; write auth | **Moderate** — structured data valuable for retail LLMs |
| OpenLibrary | Digitized catalog | CC0 / public domain | Internet Archive (nonprofit) | High-volume covers-API requests exhaust edge/storage | 100 req / 5 min / IP | **Low** — strong institutional opposition to paywalling |
| arXiv | Academic preprints | CC-BY / custom | Cornell & Simons Foundation | Massive metadata harvesting & PDF sweeps strain legacy backend | 1 req / 3 s; single concurrent connection | **Low** — firm commitment to barrier-free distribution |
| Weird Gloop (OSRS Wiki) | Specialized wiki | Custom open license | Ad revenue & community | 250M monthly bot requests; bursts >1,000 rps, 10× human compute | Deactivated Google Translate proxy; behavior analysis | **High** — private commercial operator with big infra bills |
| Codeberg | Git hosting / FOSS | FOSS | Non-profit association | LLM crawlers bypass controls; solved PoW in 2025 | Upgraded Anubis difficulty & backend limits | **Moderate** — community non-profit, sensitive to central gateways |
| Fandom | Multi-topic wikis | CC-BY-SA | Venture-backed commercial | Aggressive scraping of revisions/diffs, bypassing caches | Hard login walls on heavy pages, degrading retention | **High** — commercial entity seeking monetization vs declining ad yield |

## Mathematical Modeling of the Unit Economics

A representative scientific metadata catalog processes **V_total = 100,000,000 requests/month**. Automated bot traffic accounts for 65% of volume (**V_bot = 65,000,000**).

Operational costs:
- **Edge-cached request** `C_cache = $0.00001` / request
- **Origin compute** `C_compute = $0.001` / request (compute-heavy backend query)
- **Network bandwidth** `C_bandwidth = $0.0000117` / request (≈150 KB payload @ $0.08/GB)
- **Human cache-miss ratio** `K_human = 0.10`
- **Crawler cache-miss ratio** `K_bot = 0.70` (crawlers iterate rare/historical/raw records)

Baseline infra cost:

```
C_total      = C_human_ops + C_bot_ops
C_human_ops  = V_human · [ (1 - K_human)·C_cache + K_human·(C_compute + C_bandwidth) ]
C_bot_ops    = V_bot   · [ (1 - K_bot)·C_cache  + K_bot·(C_compute + C_bandwidth) ]

C_human_ops  = 35,000,000 · [0.90·0.00001 + 0.10·(0.001 + 0.0000117)] ≈ $3,856
C_bot_ops    = 65,000,000 · [0.30·0.00001 + 0.70·(0.001 + 0.0000117)] ≈ $46,227
C_total      ≈ $50,083 / month
```

Unmitigated bot traffic consumes **over 92%** of the total IT budget.

Introduce a per-request micro-fee `p_micro` paid by bots. `α` = fraction of crawling traffic that pays for reliable, unblocked access; the rest `(1 - α)` is blocked at the edge at `C_reject = $0.000005`/request.

```
B_monthly        = Revenue - Total Cost
Revenue          = α · V_bot · p_micro
C_paying_bots    = α · V_bot · [ (1 - K_bot)·C_cache + K_bot·(C_compute + C_bandwidth) ]
C_rejected_bots  = (1 - α) · V_bot · C_reject
```

```
    MONTHLY BUDGET BALANCE (USD)
      ^
      |                                       --- Tier 3 ($0.0050)
$20K  |                                   ---/
      |                               ---/
$10K  |                           ---/
      |                       ---/
  $0  +-------------------*--/-------------------> BOT CONVERSION RATE (alpha)
      |               *  /  --- Tier 2 ($0.0015)
-$10K |           *  /--/
      |       *  /--/
-$20K |   *  /--/   --- Tier 1 ($0.0001)
-$30K |  /--/
      v
         0%  5%  10%  15%  20%  25%  30%  35%  40%
```

**Tier 1 — low-friction ($0.0001/req):** No positive breakeven exists. Revenue per paying request ($0.0001) is below origin cost (`C_compute + C_bandwidth = $0.0010117`) — the provider loses money on every paying request. **Critical threshold: micro-fees must exceed the actual origin compute cost.**

**Tier 2 — cost-reflective ($0.0015/req):** Breakeven at **α ≈ 8.1%**. At 15% conversion: Revenue $14,625, Cost $11,166 → **$3,459/month surplus**.

**Tier 3 — commercial API ($0.0050/req):** Breakeven at **α ≈ 1.5%**. At 10% conversion → **$23,944/month surplus**.

## Competitive and Overlapping Solutions Landscape

| Paradigm / Protocol | Technical Implementation | Identity / Trust Validation | Settlement Channel | Maturity | Key Risks & Drawbacks |
|---|---|---|---|---|---|
| IETF Web Bot Auth | Cryptographic signatures in HTTP headers (RFC 9421) | Ed25519 keypairs vs public JWKS directories | None (identity only) | Draft/experimental; Google & Akamai early trials | Verifies identity but handles no payment |
| Really Simple Licensing (RSL) | Machine-readable `license.xml` referenced in robots.txt | Open Licensing Protocol (OLP) handshake | Programmatic subscription & attribution routing | Early-stage; launched Sep 2025 (Medium, Reddit, Yahoo) | Licensing catalog only; still needs a CDN to enforce |
| Decentralized HTTP 402 / x402 | Native client execution of HTTP 402 | Dynamic cryptographic invoice generation | Lightning / EVM stablecoins (USDC/USDT) | Conceptual; small dev toolsets & proxies | Wallet friction; no standardized CDN tooling |
| W3C Web Payments | Browser-native payment-flow APIs | Cryptographically signed identity credentials | Card rails (Stripe/PayPal) or Web3 wallets | Mature, but optimized for human checkout | High latency/friction; unsuitable for high-speed API |
| Centralized CDN paywalls | Cloudflare Pay-Per-Crawl / Akamai verified-bot | Closed-source behavioral analysis & IP reputation | Proprietary billing engine (Cloudflare = MoR) | Commercial beta; Stack Overflow co-deploy | Centralized gatekeeper extracts fees; platform lock-in |

## Legal, Licensing, and Redistribution Realities

```
+-------------------------------------------------------------------------+
|                      LEGAL FRAMEWORK MATRIX                              |
+-------------------------------------------------------------------------+
|  CC0 / PUBLIC DOMAIN:                                                    |
|  * Permits unilateral reselling and caching.                            |
|  * Highly vulnerable to "mirror trap" leakage.                          |
+-------------------------------------------------------------------------+
|  CC-BY / ODbL:                                                          |
|  * Requires attribution and sharing of derivative databases.            |
|  * Commercial wrappers must comply with share-alike clauses.            |
+-------------------------------------------------------------------------+
|  EU DATA DIRECTIVE (DSM Art 4):                                         |
|  * Statutory right to opt-out of machine-learning ingestion.            |
|  * Enables enforcement of pay-per-crawl terms in Europe.                |
+-------------------------------------------------------------------------+
|  US "FAIR USE" DOCTRINE:                                                |
|  * Transformative indexing historically protected under fair use.       |
|  * Real-time RAG directly displacing source traffic is highly contested.|
+-------------------------------------------------------------------------+
```

**Unilateral caching vs consent.** Under CC0 / public domain, any third party can scrape, package, and resell access without the provider's consent. Under **CC-BY-SA / ODbL**: (a) **share-alike** — a commercial caching layer charging for access may violate share-alike if it does not redistribute the modified infrastructure/database freely; (b) **attribution** — RAG engines serving compiled answers without linking the source are in direct violation, giving operators legal grounds to demand compliance or compensation.

**EU TDM opt-out (DSM Art 4).** Commercial TDM of public sites is permitted *unless* the rights holder reserves rights "in an appropriate manner" (machine-readable). Programmatic opt-outs in robots.txt/llms.txt give EU repositories a statutory basis to block crawlers and mandate paid-API negotiation.

**US fair use.** *Kelly v. Arriba Soft* and *hiQ v. LinkedIn* established transformative indexing as generally fair use. But modern RAG **substitutes** for the source (market substitution undermines §107), and dozens of 2026 lawsuits are pushing toward a permission-and-licensing framework over "publicly visible = free to ingest."

## Precedents in Public-Data Infrastructure Monetization

- **Alchemy / Infura (public blockchains).** Chain ledgers are public-domain; anyone can run a node free. Alchemy/Infura built profitable businesses charging for high-performance, low-latency, SLA-backed endpoints. *Enterprises pay not for the data but for guaranteed availability and speed.* **(This is the escape from the mirror trap.)**
- **Wikimedia Enterprise.** Big tech scraped Wikipedia millions of times/minute for search cards and voice assistants; Wikimedia built a commercial, real-time, pre-packaged-dump endpoint. Subscription fees subsidize the free public platform.
- **SerpAPI / commercial API engines.** SerpAPI scrapes Google/Bing and sells clean JSON. Buyers pay for stability, security, and structured formatting even though the underlying data is free to harvest elsewhere — proving willingness-to-pay for reliable, maintained pipelines.

## Shortlist of High-Viability Providers and Consent Paths

1. **Civic / transit / mapping (e.g. OpenStreetMap).** Vector tiles, geocoding. >100B req/month. ODbL. Compute-heavy tile rendering lets OSM unilaterally meter a paid edge; commercial apps present an Ed25519-signed micropayment token to bypass edge rate limits. Third-party tile caching restricted by ODbL share-alike.
2. **Specialized taxonomic / imagery catalogs (e.g. DiscoverLife).** Hi-res taxonomic images + mapping metadata. >60M req/month. CC BY-SA / custom. Integrate RSL into metadata; mandate a per-image egress fee from commercial visual-model developers while preserving free authenticated academic access.
3. **Developer / FOSS infrastructure (e.g. Read the Docs, SourceHut).** Manual source files, raw repos, git history. 50–200M req/month. GPL/AGPL/MIT. Self-hosted HTTP 402 proxy (Go middleware + stablecoin rails) charges a micro-fee for intensive queries (git-blame, bulk doc zips) — bypasses proprietary payment networks.
4. **Cultural heritage / metadata registries (e.g. MusicBrainz).** Structured releases, artist indexes, relational tags. >300M req/month. CC0 / CC-BY-NC-SA. Replace rigid IP rate-limits with cryptographic micropayments; commercial taggers pay micro-fees for real-time search, funding MetaBrainz.
5. **Open-access metadata indices (e.g. DOAB, OpenAlex).** Publication indexes, citation graphs, monographs. 100–500M req/month. CC BY / CC0. Gate real-time search APIs; AI scrapers present a signed paying token while institutions bypass via IP-reputation/federated library login.

## Adversarial Verdict and Load-Bearing Assumptions

**Where the thesis holds.** Highly viable for **dynamic, compute-heavy open-data utilities** where value depends on real-time accuracy and infrastructural availability — mapping tiles, live code repos, transit feeds, frequently-updated metadata indexes. Commercial users need continuous, reliable API access; a micropayment layer lets providers bypass contractual negotiation and monetize AI agents directly to subsidize the public good.

**Where the thesis fails.** Fails for **static, easily-mirrored, public-domain datasets** (the *mirror trap*). For static scientific archives (Zenodo, OpenLibrary) or historical text catalogs, a single well-funded crawler pays the micro-fees once, downloads the complete DB, and torrents it free on HuggingFace — recurring revenue collapses, infra costs remain. Many public institutions also face insurmountable regulatory/ideological barriers: stablecoin tax-compliance overhead plus philosophical opposition to gating knowledge make micropayments a non-starter for many academic/library networks.

```
+--------------------------------------------------------------------------+
|                     LOAD-BEARING CORE ASSUMPTIONS                        |
+--------------------------------------------------------------------------+
|  1. REAL-TIME INDISPENSABILITY — data value decays fast, making static   |
|     cached mirrors / historical dumps useless for modern RAG.            |
|  2. SECURE AGENT AUTHENTICATION — crypto bot-identity (e.g. Web Bot Auth)|
|     reaches wide adoption, preventing bots from spoofing human browsers. |
|  3. ZERO-FRICTION TRANSACTION NETWORKS — L2 scaling handles millions of  |
|     sub-penny txns with negligible fees and no congestion.               |
|  4. WILLINGNESS TO PAY OVER EVASION — AI developers prefer transparent   |
|     micro-fees to investing in residential-proxy evasion networks.       |
+--------------------------------------------------------------------------+
```

If these four hold, cryptographic micropayments can sustain the long-tail open web. If they fail, the open web bifurcates into gated centralized networks protected by dominant security providers, and underfunded unprotected platforms vulnerable to aggressive automated scraping.
