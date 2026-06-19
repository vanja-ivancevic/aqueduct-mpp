# Deep Research Question — AI-Crawler Load on Long-Tail Open-Data Providers

**For: deep-research AIs that read hundreds of sources and compile reports.**

---

## Title

The economics of AI-crawler load on long-tail open-data providers, and whether per-request micropayments are a viable relief-and-sustainability mechanism.

## Core question

As AI training and agentic-retrieval traffic scales, are small and mid-sized open-data providers (scientific databases, biodiversity/taxonomy catalogs, digital libraries, civic/mapping data, GLAM/cultural-heritage collections, open-access metadata, FOSS infrastructure) facing a structural cost crisis — and is a per-request micropayment layer (HTTP 402-style, settled in stablecoins, where payment doubles as bot identity/authorization) a credible economic and technical solution versus the alternatives currently in use? Build the evidence base, then assess the thesis adversarially.

## Sub-questions to investigate (cite primary sources for each)

1. **Magnitude of the load.** Quantify documented cases where AI/LLM crawlers (GPTBot, ClaudeBot, Bytespider, Amazonbot, Meta, Google-Extended, and unidentified scraper swarms) caused outages, bandwidth blowouts, or cost spikes for open-data/open-knowledge providers. Pull specific numbers, dates, operator statements, and incident postmortems. Known leads to verify and expand: DiscoverLife ("2M bot hits/day," Nature d41586-025-01661-4), Read the Docs (73 TB/month, ~$5k), Zenodo (500 req/s, daily blocking), DOAJ (968% single-day spike), Wikimedia (bandwidth +50% since 2024, ~65% expensive traffic from bots), OpenStreetMap (Overpass/Nominatim, 100k+ scraper IPs), VizieR/CDS Strasbourg (Oct 2025 bulk-download gating), SourceHut, FSF/GNU Savannah, Perseus Digital Library. Find more, especially outside English-language and outside the most-cited names.

2. **Who bears the cost and why they can't pay.** Characterize the funding/operating model of these providers (single-academic, grant-funded, volunteer nonprofit, university-hosted, government). What is their typical infrastructure budget, and why is enterprise anti-bot (Cloudflare Enterprise, Fastly, DataDome) economically or philosophically off-limits?

3. **What they do today, and why it's inadequate.** Survey current defenses and their failure modes: proof-of-work firewalls (Anubis — quantify adoption: which projects, when), robots.txt (compliance rates), User-Agent/IP blocking, rate limits, auth-gating bulk access, CAPTCHAs, Cloudflare's free tier and Pay Per Crawl (July 2025 launch — adoption, pricing floor, settlement model, who's actually using it), and "AI scraper tarpits." Where does each break for a provider that wants to *stay open to legitimate users and good-faith agents*?

4. **The micropayment alternative — does the math work?** Model the unit economics. At plausible per-request prices ($0.0001–$0.01), what request volumes turn a cost center into break-even or surplus for a provider serving, say, 10M–1B requests/month? Compare to their bandwidth/compute cost. Where is the crossover? What fraction of crawler traffic would need to convert to paying to matter? Is the AI-consumer side willing to pay these amounts rather than route around (scrape the open web copy, use a mirror/dump, or just absorb being blocked)?

5. **Payment-as-authentication.** Assess the claim that a signed micropayment is a better bot-identity/authorization signal than IP/UA heuristics or proof-of-work — for both sides (provider gets accountable, rate-limitable, paying clients; agent gets reliable, unblocked access). Compare to emerging standards: Web Bot Auth, IETF HTTP Message Signatures, x402, Cloudflare's signed-agent proposals, RSL (Really Simple Licensing).

6. **Redistribution & licensing reality.** For the candidate providers, what licenses govern their data (CC0, CC-BY, ODbL, public domain, bespoke), and what does that permit a third party fronting/caching/reselling access to do? Where does a paid caching/serving layer require the operator's explicit consent versus being permissible unilaterally? Map the legal terrain (including the EU TDM opt-out, US fair-use/scraping case law trajectory, database rights).

7. **Adjacent precedent & competition.** Who is already monetizing access to *public* data as maintained infrastructure (Alchemy/Infura for public chains, SerpAPI, Wikimedia Enterprise, commercial mirrors of open datasets, RapidAPI long tail)? What does their existence prove about willingness-to-pay, and where is the genuinely unserved long tail they ignore?

8. **Adversarial / kill-the-thesis section (required).** Argue the strongest case *against* micropayments solving this: data that's CC0 can be mirrored once and redistributed free (killing repeat demand); crawlers may simply not pay and eat the block; the providers most in pain may be unwilling to "paywall knowledge" on principle; settlement/wallet friction; chicken-and-egg adoption; and the possibility that Cloudflare/standards bodies absorb this natively and commoditize any third-party layer. Conclude with the conditions under which the micropayment thesis *does* hold versus where it's dead on arrival.

## Output format

- (a) An evidence table of ≥20 provider incidents (provider, data type, license, funding model, documented pain with citation+date, current defense, would-they-plausibly-adopt-paid-access).
- (b) A unit-economics model with stated assumptions.
- (c) A landscape map of competing/overlapping solutions.
- (d) A ranked shortlist of providers where a paid relief layer is most viable, with the licensing/consent path for each.
- (e) A clear adversarial verdict: where the thesis holds, where it fails, and the 3–4 load-bearing assumptions the whole idea rests on.

Prioritize primary sources — operator blog posts, incident reports, mailing-list threads, Nature/news coverage with named figures — over secondary commentary.
