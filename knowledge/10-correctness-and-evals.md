# 10 — Correctness & Eval Loops (the crux)

The hardest, highest-risk part of Aqueduct: getting data **correctly** from an arbitrary upstream,
and **proving** it so consumers can depend on a Tap. This is the design.

> **MVP (static files):** the "upstream" is the **source file** (parquet/CSV/JSON). Source-agreement =
> re-read the file and diff vs what the Tap served; coverage = DuckDB `COUNT(*)` vs returned rows
> (exact, not heuristic); pagination is just DuckDB `LIMIT`. Volatility/personalization mostly
> N/A within a snapshot — they reappear only *across refreshes*. The general model below covers the
> roadmap (live/messy sources); for MVP it simplifies to "does the Tap still match its file?".

## Reframe: correctness = fidelity to upstream, not absolute truth

You have no truth oracle for arbitrary public data. So don't claim one. Define:

> **A Tap is correct when it faithfully delivers what the upstream provider would return —
> normalized, complete, uncorrupted, fresh.** Ground truth = the upstream source itself.

Consequence: **the upstream is the oracle.** "Does the Tap agree with a fresh upstream fetch?"
needs nothing external. **Source-agreement is the PRIMARY eval**; everything else supports it.

## Layered design

### L0 — Faithful passthrough (foundation)
Tap = delivery layer. Serve normalized rows; keep a hash (or raw) of the upstream response so
correctness decomposes into: (a) normalized derives from raw, (b) raw matches upstream now.

### L1 — Extraction correctness (getting data right)
The parser config the CLI writes. Make it reliable:
- **Multi-sample**: onboard against K *diverse* upstream samples (pagination, empty, error, edge), not one.
- **Schema conformance**: every extracted row matches declared types / required / non-null. Reject malformed.
- **Coverage check** ⭐: did extraction capture *all* records present, or silently drop some? Compare
  extracted count vs records-in-raw (array length / row markers / page totals). **Silent partial
  extraction is the nastiest failure** — looks fine, quietly wrong.
- **Determinism**: no LLM in extraction (rule). Same input → same output.
- **Prefer structured sources**: if upstream has OpenAPI / JSON Schema / SQL DDL, use it as the
  extraction contract — far more reliable than inferring from HTML. Rank source types by reliability:
  **JSON API ≈ SQL (high) > CSV/file > HTML scrape (low, brittle)**. Lead the demo with a structured source.

### L2 — Agreement evals (continuous)
| Eval | Catches | Needs oracle? |
|---|---|---|
| **Source-agreement** (primary) | staleness, parser drift, corruption | no — re-fetch upstream, diff |
| Golden queries | regressions | pinned at onboarding (may go stale on legit upstream change) |
| Invariants | corruption (ID format, ranges, monotonic dates, count bounds) | no |
| Freshness | stale data vs upstream cadence | no |

Source-agreement: periodically + sampled on live traffic, re-fetch the *same query* direct from
upstream, run extraction, diff vs what the Tap served. Mismatch → drift/staleness → trigger heal.
Golden failure alone = "investigate"; source-agreement decides drift vs legitimate upstream change.

### L3 — Confidence scoring + honest exposure
Combine → published **score + last-verified timestamp + coverage %**. Don't overclaim. Agents read
pre-pay. **Refund-backing**: row provably disagreeing with upstream (eval or consumer challenge) →
refund. Economic backstop for honesty.

## The eval LOOP (gating)
- **Onboarding gate**: candidate config must pass schema + coverage + goldens + source-agreement on
  K samples before live. CLI iterates until pass.
- **Repair gate**: same suite on the proposed diff; canary %, auto-rollback on regression.
- **Continuous**: cron + sampled-on-traffic source-agreement → maintains score, triggers heal.

## Hard parts (honest)
1. **Silent partial extraction** — drops records, looks fine. → coverage checks + agreement on full
   result sets, not spot rows.
2. **Upstream non-determinism** — live prices / randomized / time-varying data false-positive a diff.
   → per-field **volatility classification** at onboarding: volatile fields checked for shape/range/
   freshness, stable fields exact-diffed.
3. **Verification cost + rate limits** — re-fetching upstream burns quota. → sample (verify X% +
   periodic), don't verify every request; budget against upstream limits.
4. **Pagination / large results** — extraction + coverage must handle multi-page.
5. **Derived/aggregated data** — if a Tap transforms (not pure passthrough), upstream isn't a direct
   oracle for the output → transform needs its own invariants + goldens.
6. **Licensing/ToS** — verification fetches + re-serving raise upstream-terms questions (roadmap).

## De-risking spike (build this first — targets exactly the concern)
Free, local + testnet, on ONE real structured API:
1. Pick a reliable JSON public API (gov/open data).
2. CLI (claude/codex) writes extraction config from K samples.
3. Implement eval suite: schema-conformance + **coverage** + **source-agreement** + 2 goldens + invariants.
4. **Prove it**: deliberately corrupt the config (drop a field / wrong selector) → evals must FAIL and
   localize the break → CLI repairs → evals pass → promote. (= self-heal loop on real data.)
5. Wrap validated config in `tempo.session` Tap; agent pays per row on Moderato testnet.

This single spike de-risks both worries — extraction correctness AND the eval/heal loop — on real
data, for free. Everything else is built around what this proves.
