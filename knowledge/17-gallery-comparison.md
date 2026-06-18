# Gallery comparison: Aqueduct Taps vs Claude Code from scratch

The honest, measured case across **five data types**. For each example Tap we ask the same
natural-language question two ways and measure cost, speed, and correctness. Harness:
`scripts/bench-gallery.ts` (re-runnable). Model: `claude-opus-4-8`.

- **Arm A — Claude from scratch:** given ONLY the question + a computer (no URL). It must discover where
  the data lives, fetch it live, and compute the answer.
- **Arm B — the Aqueduct Tap data plane:** plan one constrained query, execute via DuckDB. No LLM in the
  path (invariant 1); data billed at `unitPrice`/row.

## Results (2026-06-18)

| dataset | why Claude struggles | Claude $ | Claude time | Tap $ | Tap time | cost× | speed× | match |
|---|---|--:|--:|--:|--:|--:|--:|:-:|
| space science (exoplanets) | hard to FETCH (NASA TAP / ADQL, not a known URL) | $0.3185 | 35.9s | $0.0001 | 4758ms¹ | 3185× | 8× | ✓ |
| geophysics (USGS quakes) | FRESH (sub-minute) — yesterday's copy is wrong | $0.1282 | 8.5s | $0.0001 | 237ms¹ | 1282× | 36× | ✓ |
| planetary defense (NASA NEO) | nested JSON needing FLATTEN/assembly | $0.1609 | 23.8s | $0.0001 | 4ms | 1609× | 5780× | n/a² |
| foreign exchange (ECB rates) | vendor-maintained canonical snapshot | $0.1191 | 11.7s | $0.0001 | 4ms | 1191× | 2787× | ✗³ |
| culture/web (Wikipedia views) | nested JSON + daily; stable ranking | $0.1671 | 20.6s | $0.0001 | 15ms | 1671× | 1361× | ✓ |

**Totals:** Claude **$0.8939** vs Tap data **$0.0005** — **~1788× cheaper** at the data-delivery layer.
Onboarding each Tap was deterministic ($0 LLM); the data plane runs $0 LLM (invariant 1).

¹ **Tap time, two regimes.** For *live-URL* Taps (exoplanets, USGS) the harness measures a **cache-miss**
— it re-reads the upstream every query (it bypasses the runtime result cache). That's the upstream-bound
SLO, and it *still* beats Claude (which pays the same fetch *plus* multi-turn reasoning). For *snapshot*
Taps the read is local (4–15ms). The **cache-hit** served path is `<100ms` for all of them (measured
68ms on exoplanets against a local read) — so the per-query speed advantage in production is the larger
number, not the cache-miss one.

² **NEO is a static snapshot** vs Claude's live "next 7 days" — different windows, so correctness is n/a
(we compare cost/speed only).

³ **FX ✗ is the most instructive result.** Claude fetched a *valid* USD/JPY number — just a different one
(live mid-market vs the ECB daily reference rate the Tap serves). "What is the USD/JPY rate" has many
right answers depending on source, definition, and timestamp. The Tap pins **one** canonical, sourced,
reproducible value. That determinism *is* the product a data vendor sells — see below.

## What it shows

- **Cost is decisive and consistent: ~1,200–3,200× cheaper per delivery**, every data type. This is
  invariant 1 paying off — the agent's tokens dominate Arm A; the Tap's data plane spends $0 LLM.
- **Speed: 8–5,780× faster.** Even the conservative cache-miss number wins (the Tap pays one fetch;
  Claude pays fetch + reasoning + 2–3 turns). Cache hits are `<100ms`.
- **Correctness holds** where it's deterministically checkable (3/3), and the one "miss" exposes
  *source ambiguity*, not a Tap error.
- The "why Claude struggles" column varies by row — fetch difficulty, freshness, nesting, canonical
  source. The Tap collapses all of them to one constrained query.

## The real model: a professional data vendor + microtransactions

The benchmark measures a *single* query, where the headline is cost/speed. But that undersells it,
because **the product is not "a cheaper one-shot analyst."** It's the data-vendor model at micro-scale:

> A vendor maintains a fresh, clean dataset once. Many consumers (humans or agents) **micro-buy** exactly
> the slice they need — no pipeline, no subscription floor, no signup.

This is the classic **build-vs-buy** decision, newly possible at fractions of a cent because MPP settles
per-query to a wallet. Even for data Claude *can* fetch, you wouldn't build your own pipeline when:

1. **Occasional access** — you query a few times; a fetch+parse+host+cron pipeline is overkill.
2. **Long-tail breadth** — you need slices from *many* datasets; nobody maintains 50 bespoke pipelines.
3. **Freshness / SLA** — the vendor keeps it current 24/7; your cron breaks silently and you ship stale.
4. **Normalization** — the vendor maps a messy source to a clean schema *once* (the FX/NEO flatten in
   `scripts/refresh-*.ts`); every consumer would otherwise reinvent it.
5. **Source volatility** — when the upstream changes format/URL, the vendor fixes it for everyone; your
   private pipeline just breaks.
6. **Agents specifically** — an autonomous agent can't host infra at all. It can only *buy* per query.

This is the **Bloomberg / Refinitiv / Polygon** model — maintained canonical datasets, paid access —
brought to (a) the **long tail** of datasets too niche for those vendors to bother with, and (b)
**agent-native per-query microtransactions** instead of enterprise contracts. The builder owns the
refresh (custom per dataset — see `scripts/refresh-fx.ts`, `refresh-pageviews.ts`); Aqueduct owns
serving, metering, payment, discovery, and the honored freshness window.

## Honest limits

- **The one-shot, single-user case is a wash or a loss** when the data is trivially fetchable *and*
  you'll only ask once: Claude fetches it live in one shot. The Tap wins on **repeat / multi-consumer /
  maintained-freshness**, not on a lone question. (Crossover ~2 queries; see `knowledge/16`.)
- **Demand ≠ cost-viability.** The economics are spectacular (~99.9% margin, viable from query 1 on a
  scale-to-zero host — `knowledge/16`), but a buyer must still *value* the convenience at $0.0001/row.
- **FX-style source ambiguity cuts both ways:** the canonical-source value is real, but only if the
  vendor's source choice is the one the consumer wants. Provenance must be published with the Tap.
