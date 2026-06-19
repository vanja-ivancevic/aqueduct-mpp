# The Economics of AI-Crawler Load on Long-Tail Open-Data Providers (Report 2)

> Second independent deep-research pass (different model, different source set) answering
> `research/deep-research-question.md`. Converges with `supply-side-report.md` on the mirror trap and
> adds three decisive refinements for Aqueduct: (1) the **training-time vs inference-time** split —
> micropayments only work for inference-time, latency/freshness-sensitive canonical APIs; (2) a named
> competitor, **Cloudflare Pay Per Crawl**, to differentiate from; (3) the **cache** is the economic
> enabler of sub-cent pricing (no origin compute on a hit). See `aqueduct-mirror-trap` memory.

## Executive overview

Aggressive AI/LLM crawlers have created a measurable cost and reliability problem for open-data infrastructures: institutional repositories, discipline repositories, documentation hosts, GLAM collections, map services, code forges, digital libraries. Incidents include multi-million-request surges that knock services offline, multi-terabyte bandwidth bills, and a structural shift in traffic mix from humans to bots that raises baseline cost without revenue.

Operators respond with a patchwork — robots.txt, IP/UA blocking, rate limiting, CAPTCHAs, Cloudflare AI Audit, dedicated bot endpoints, proof-of-work firewalls (Anubis) — but COAR and GLAM-E Lab surveys emphasize these are brittle, labour-intensive, and often degrade legitimate machine and human use.

A micropayment layer (HTTP-402, request-level pricing, stablecoin or CDN-intermediated) could convert some bot load from pure cost into revenue while acting as a strong authentication signal. But economics and adoption are uneven: for large/mission-critical crawlers hitting popular infra at scale, even tiny per-request fees cover current costs if paid on a meaningful fraction of traffic — yet most long-tail providers face legal, ideological, and coordination constraints that make pay-per-request unlikely near-term.

## A. Evidence base (selected incidents)

- **DiscoverLife** — ~3M species photographs. Feb 2025: "millions of hits every day" from scraping bots slowed the site to unusable. Ad-hoc blocking; no sophisticated bot infra. Licensing heterogeneous (image owners reserve copyright).
- **Read the Docs** — docs for 80k+ OSS projects; ~35M views / 40 TB/mo pre-surge. May 2024: one AI crawler pulled 73 TB zipped HTML, ~10 TB in a day, >$5k bandwidth. Blocking AI crawlers cut daily traffic 800 GB → 200 GB, saved ~$1.5k/mo.
- **Zenodo** (CERN/OpenAIRE) — sustained ~180 req/s avg, 250+ peak; Nov 2025 search API rate-limited after covert harvesting up to 500 req/s. Deposit-level licenses; service free. EU/Horizon funded.
- **DOAJ** — journal metadata CC BY-SA 4.0, article metadata CC0. 419% traffic rise over a semester, single-day peak 968% over prior year, attributed to "Agentic AI" scrapers bypassing CAPTCHAs and mimicking residential traffic.
- **Wikimedia** — text CC BY-SA, 144M+ media. Since Jan 2024 multimedia bandwidth +50% from scraping; ≥65% of resource-intensive traffic from bots though bots are ~35% of pageviews. Wikimedia Enterprise monetizes commercial reuse.
- **OpenStreetMap** — ODbL. Early 2026: ~100k+ IPs making coordinated low-rate requests (shift from 1-few IPs at 10k+). Nominatim on donated hardware, 1 req/s policy, heavy users expected to self-host.
- **SourceHut** — founder spends 20–100% of weekly time mitigating LLM crawlers that ignore robots.txt, hit expensive endpoints (git-blame, every commit), use tens of thousands of IPs; dozens of brief outages/week.
- **Perseus Digital Library** (Tufts) — 2025 repeated 503s from bot swarms "likely related to data capture for training models"; manual IP blocking useless (rotating addresses).
- **EconStor** (ZBW) — mid-2025 deployed an AI filtering system after AI bots caused performance issues and outages; stability improved, downloads fell slightly.
- **FSF / GNU Savannah** — DDoS-class attacks since Aug 2024; significant traffic from AI-company crawlers; Jan 2025 botnet ~5M IPs hit Savannah.
- **GLAM-E Lab survey** (43 institutions) — 39 report increased traffic, 27 attribute it to AI training bots; many servers slow/offline under swarms scraping entire collections.
- **COAR survey** (66 repositories, Apr 2025) — >90% encountering aggressive bots, usually more than weekly; many slowdowns/outages; some blocking machine access (disrupting legitimate aggregators/indexers). Conclusion: none of robots.txt/firewall/IP-block/rate-limit/CDN is sufficient without also blocking desirable traffic.
- **BMJ** — >100M accesses from HK/SG data centers over three weeks from aggressive bots crawling entire sites.
- **Macro** — Imperva 2025: automated traffic surpassed human in 2024 (51% of traffic, 37% bad bots), AI/LLM cited as drivers. Cloudflare Radar: ~30% of traffic bots, AI bot traffic +18% YoY (48% incl. newly onboarded domains).

## B. Who bears cost & why they can't pay

Most are small/mid non-profits, academic projects, public institutions. ARL: OA infra ~$786k/institution avg, ~2.26% of library budgets; ~$5M total IR infra across 46 libraries. Zenodo EU-grant funded, free service. Perseus on NEH grants (~$349k/3yr) + Tufts. Read the Docs/SourceHut/FSF on ads/sponsorship/donations — a single abusive crawler wipes out months of budget in days. GLAMs on fixed public/grant budgets where hosting scales with traffic but revenue doesn't.

Enterprise anti-bot is a hard fit: cost/complexity (advanced Cloudflare needs config + Stripe), vendor lock-in concerns (FOSS resists centralizing behind a commercial CDN — SourceHut culture), ideological commitments (OA/GLAM/FOSS open-access + privacy values), jurisdiction/procurement friction (public institutions).

## C. Current defences & limits

- **robots.txt / llms.txt** — voluntary, no enforcement. Major crawlers (GPTBot, ClaudeBot, Google-Extended) mostly honour it; a growing minority ignore it (~3.3% late 2024 → >13% mid-2025). llms.txt is a content map, not an opt-out; no evidence major models change training behaviour from it.
- **IP/UA blocking + rate limiting** — brittle vs distributed residential-proxy scraping (Perseus, SourceHut, OSM). COAR: not sufficient without blocking good machines.
- **Proof-of-work (Anubis)** — SHA-256 challenge proxy; adopted by GNOME GitLab, kernel.org lore, FFmpeg, Wine, UNESCO repos, FreeCAD, SourceHut. Negligible for humans, costly for scrapers at scale; but no revenue, excludes low-power devices, bypassable by botnets.
- **Cloudflare AI Audit / AI Labyrinth / Pay Per Crawl** — Audit free on all plans (visibility + one-click block). AI Labyrinth = decoy-maze tarpit. **Pay Per Crawl** (private beta Jul 2025): per-crawl price, min **$0.01/crawl**, per-crawler charge/block/allow, settled via **Stripe** (no stablecoins in prod); late-2025 added Discovery API + mandatory Web Bot Auth HTTP signatures on payment headers.
- **Tarpits** (Nepenthes, Iocaine) — infinite fake content / training-data poisoning. Reduce load but risk ethics + arms race; no revenue.

## D. Micropayment unit economics

Baseline marginal cost assumed ~**$5 per million requests** ($0.000005/req, bandwidth + basic infra on commodity hosting; some egress-metered clouds higher). Read the Docs implied ~$0.07/GB overage; a small blog paid +$90/mo (~$0.003/GB).

R = monthly requests, c = cost per million, p = price per paid request, f = paying fraction. C = (R/1e6)·c, V = R·f·p, Π = V − C.

- **10M/mo** (cost $50): p=$0.0001, f=0.1 → $100 rev, +$50. p=$0.001, f=0.1 → $1,000 rev, +$950.
- **100M/mo** (cost $500): p=$0.0001, f=0.1 → $1,000 rev, +$500. f≈0.05 ≈ covers cost. p=$0.001, f=0.1 → $10,000, +$9,500.
- **1B/mo** (cost $5,000): p=$0.0001, f=0.1 → $10,000, +$5,000. f=0.01 → $1,000, −$4,000 deficit. p=$0.001, f=0.01 → $10,000, +$5,000.

**Critical variable = the fraction of traffic that pays.** Where 60–80% of traffic is bots, converting 10–20% of bot traffic (≈6–16% of total) to a paid channel covers marginal cost with surplus.

**NOTE (reconciles with Report 1):** this cheap model assumes a CACHE HIT (no origin compute). Report 1's no-breakeven-at-$0.0001 result used origin compute cost $0.001/req. The reconciliation: sub-cent pricing is only viable when you serve from cache and avoid origin compute — which is exactly Aqueduct's hot-path design.

**Buyer willingness:** SERP APIs $0.0003–0.002/query; web3 RPC (Infura/Alchemy) ~$0.40–0.45 per million CU; Cloudflare PPC floor $0.01/crawl (full-page, big AI buyers). Training-time collection minimizes per-request cost → favours free mirrors/dumps. **Inference-time agentic retrieval values latency + freshness → paid access to canonical APIs is attractive.** Conclusion: micropayments are most plausible for **high-value, low-redundancy, inference-time endpoints** (geocoding, metadata resolution, canonical dictionaries), not bulk training crawls.

## E. Payment-as-authentication

Emerging identity standards (orthogonal to the payment rail):
- **Web Bot Auth** — IETF draft; HTTP Message Signatures (RFC 9421) + optional mTLS; "Signature Agent Card" JSON (identity, purpose, rate). Cloudflare ties it to PPC (signed payment headers).
- **RSL (Really Simple Licensing)** — `Authorization: License <token>`; bots fetch free/paid license tokens from a license server; servers enforce via 401/403.
- **x402 / HTTP 402** — `.well-known/x402.json` advertises payment endpoints; returns 402; USDC default token; reattempt with proof of payment.

A signed micropayment/license token beats IP/UA/PoW: durable non-spoofable identity (key+account), natural hook for differentiated rate limits/QoS, real revenue. PoW (Anubis) stays as a backstop for the non-cooperative fringe; payment-backed identity suits cooperative large AI agents.

## F. Licensing & redistribution

- **CC0 (DOAJ article metadata, many OA)** — once obtained, redistribute without restriction → origin paid layer bypassable by mirroring.
- **CC BY-SA (Perseus, Wikimedia text)** — reuse incl. commercial with attribution + share-alike; third parties can rehost and even charge for enhanced/high-availability versions.
- **ODbL (OSM)** — commercial services permitted with share-alike + attribution; this is what Stadia Maps / third-party Nominatim do.
- **Mixed/bespoke (GLAM, DiscoverLife, BMJ)** — can't lawfully rehost wholesale without permission.
- **EU** — DSM Directive Art 4 TDM exception unless machine-readable opt-out; sui generis database rights (96/9/EC) can block repeated extraction of substantial parts even when individual items aren't protected.
- **US** — hiQ v. LinkedIn limited CFAA for public data, but doesn't resolve copyright / ToS / database rights.

For CC0/ODbL, **the scarce resource is not the data — it's the canonical, up-to-date, well-managed access path.** Monetize SLA/freshness/integration, not exclusivity.

## G. Adjacent precedent

- **Blockchain RPC (Infura/Alchemy/QuickNode)** — public chain data, paid for low-latency reliable access. Infura $225–1,000/mo; Alchemy $0.45/M CU → $0.40 at scale.
- **SERP APIs (SerpAPI)** — public web data resold structured; ~$0.025/search retail, PAYG to $0.0006–0.002/query.
- **API marketplaces (RapidAPI)** — wrap public data, tiered subs, per-request overage ~$0.001–0.01.
- **Wikimedia Enterprise** — paid APIs + SLA for big reusers; free dumps + 50k on-demand req/mo free tier retained.

Validates real willingness-to-pay for **managed access** to public data (reliability, structure, support).

**Competition / commoditization:** Cloudflare (AI Audit + Web Bot Auth + AI Labyrinth + Pay Per Crawl) across tens of millions of domains = de facto standard; GoDaddy integration pushes it to mass-market hosting. IETF Web Bot Auth + RSL standardize identity/licensing. A bespoke 402 micropayment scheme risks commoditization unless it aligns with these standards.

## H. Best-fit segments

1. **OSM-based geocoding/map APIs** — ODbL permits commercial; high inference-time, latency-sensitive, hard to fully mirror. Paid signed API tier for agents.
2. **Canonical OA metadata/search (DOAJ, Zenodo)** — dumps stay free/CC0; charge for low-latency structured search (SerpAPI/Infura model).
3. **Large commons with existing products (Wikimedia)** — extend Enterprise to AI crawlers + agentic retrieval via Web Bot Auth.
4. **Flagship discipline repos / GLAMs (Perseus, EconStor)** — consortium API gateway: free human + free bulk research access, charge heavy commercial AI; EU database rights + TDM opt-out give legal leverage.

In all: not "selling the data" — charging for **managed, authenticated, high-volume access** while keeping underlying openness.

## I. Kill-the-thesis

1. **Mirroring + permissive licences kill recurring demand** — CC0/CC-BY/ODbL mirrorable once, served indefinitely; undercuts origin pay-per-request for training-time use. Works only where origin gives non-replicable value (live state, frequent change, regulatory guarantee).
2. **Worst actors won't pay** — today's offenders rotate IPs/spoof UAs/ignore robots.txt; least likely to adopt Web Bot Auth or billing. PoW/tarpits/WAF are the right tools for them, not payment.
3. **Mission/ethics objections to paywalling knowledge** — GLAM/OA/FOSS tie legitimacy to free non-discriminatory access; FSF unlikely ever to monetize crawler access on principle.
4. **Payment/wallet friction + fragmentation** — AI crawlers won't maintain hundreds of bilateral billing relationships; prefer a few intermediaries (Cloudflare, Firecrawl, Apify) or big providers negotiated once.
5. **CDN/standards commoditization** — Cloudflare already implements charging at $0.01/crawl; GoDaddy distribution. An independent 402 network risks being outcompeted.
6. **Legal uncertainty training vs access** — paying for access doesn't resolve copyright/database-rights for training; complicates "licensing access for training."

## Load-bearing assumptions

1. **Meaningful share of AI traffic is cooperative + centralised** (identifies via Web Bot Auth/RSL and pays, vs routes around / mirrors).
2. **Origins provide non-replicable, ongoing value** (fresh/canonical/latency-sensitive APIs, not static CC0 dumps).
3. **Implementation is federated but interoperable** (plug into few intermediaries or shared x402/RSL/Web Bot Auth conventions, so agents avoid combinatorial integration overhead).
4. **Open-access ethics preserved at the human edge** (humans + good-faith research bots stay free; charging narrowly targets heavy commercial AI) — else community backlash kills adoption.

Where those don't hold — highly mirrorable datasets, hostile scrapers, anti-commercial communities, or CDN-level dominance — the micropayment thesis is dead on arrival, and the realistic play is a mix of better blocking, PoW/tarpits, negotiated licensing with large AI firms, and public funding to backstop critical open infrastructure.
