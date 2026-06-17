# 11 — Adversarial Review Findings (codex gpt-5.5)

Hostile review of system structure + Figure 1, 2026-06-16. Verdicts are ours. Status tracked here.

## Resolved by the parquet/DuckDB rescope (2026-06-17)
Narrowing MVP to static structured files served via DuckDB dissolved several findings outright:
- **A11 "any dataset" is false** → scope is now explicitly parquet/CSV/JSON only. Resolved.
- **A7 coverage underspecified** → DuckDB `COUNT(*)` vs returned rows gives exact coverage. Resolved.
- **A8 per-row pricing fights cost model** → config prices by declared cost unit (`row|page|query|
  byte|result-set`); done in `core/config.ts`.
- **Ingestion / sandbox / Python / VPS risk** → acquisition is one HTTP GET; no codegen, no sandbox.
  Gone for MVP (agentic ingestion of messy sources = roadmap).
- **A4 source contract** → still required; encoded in `core/config.ts` (`source.contract`).
Remaining items below still apply.

## Applied (foundational — already in CLAUDE.md)
- **Purity contradiction fixed** — runtime is NOT pure. Split: pure *extractor*
  `(config, rawResponse, request) → rows` vs stateful *runtime shell* (fetch/cache/ledger/clock),
  deterministic *given declared inputs*. State named: config·ledger·cache·eval·deploy. [A1,A3,B1,B2]
- **Two SLOs** — cache hit `<100ms` deterministic; cache miss upstream-bound. No blanket `<100ms`. [A2]
- **Scope narrowed** — MVP = structured HTTP/SQL/file, redistribution rights, deterministic
  pagination. "Any dataset" out. Source contract required before a Tap advertises a score. [A4,A11]

## Accept — fold into 08/10 as we build
- **Constrain self-heal** [A5,A6]: auto-promote ONLY narrow parser-path fixes that preserve
  schema + unit semantics. Schema / pagination / unit / field-deletion changes → require approval
  (operator or registry). Separate eval *authorship* from *execution*; freeze raw sample + expected
  rows as an auditable bundle (so evals aren't self-consistency theater).
- **Source contract per Tap** [A4]: determinism class · volatility fields · pagination semantics ·
  identity scope · freshness window · exact comparison strategy. Gates the published score.
- **Coverage adapters per source type** [A7]: JSON → explicit array root / page cursor; SQL → count
  query; HTML → mark coverage confidence LOW; unknown → do not claim complete delivery.
- **Price by declared cost unit** [A8]: row | page | query | byte | result-set. Make `unit.definition`
  enforceable. Expose `uncachedCost` + `estimatedVerificationCost`. Drop the implicit row-only model.
- **Score provenance** [A15]: distinguish `selfReportedScore` vs `registryVerifiedScore`; include
  timestamp, sample size, source class, confidence class.

## Accept as wording / scoping fixes
- "No hidden state" → named state categories (done in CLAUDE.md). [A3]
- **Non-custodial → scope it** [A10]: document custody boundaries (who signs, escrows, relays
  vouchers, pays gas via feePayer, refunds, operator-disappearance). "We never hold funds" alone is
  insufficient.
- **Adapters "every seam" → list real seams** [A12]: also registry, Tempo settlement, cache backend,
  clock, sandbox, wallet/signing, discovery, eval runner, scrape engine. Either add interfaces or
  soften the claim.
- **Refunds → roadmap, not core** [A14,B24]: "provably wrong" needs row identity + raw capture +
  challenge protocol + dispute window. Remove from core claims until specified.

## Hackathon scope (codex A13 — accepted)
Judged path = **ONE structured JSON Tap**: hand-audited evals, cached reads, session billing, and a
deliberately-corrupted-config repair (narrow parser fix). **Drop from judged path:** Akash, registry,
refunds, research scheduler, generalized datasets, full self-heal trust chain. These are roadmap
slides. The "stretch wow" (self-heal) is the hardest part — demo the narrow version only.

## Figure 1 — fixes
Real contradictions to fix: data-plane `<100ms·deterministic` label vs the `miss→fetch` upstream edge
[B1,B2]; "the oracle" overstated [B3]; "~2 tx" overclaim [B14]; dashed planes imply clean split many
edges cross [B25]. → relabel honestly, show **cache-hit vs cache-miss** paths, reframe the dashed
boundary as the **LLM-confinement boundary** (not purity), soften "oracle"/"~2 tx". Add a few critical
actors (Operator, Cache, Deploy, Registry, last-good/rollback store) OR caption as "simplified core
flow." The 20 "missing component" notes are abstraction, not error — don't cram 25 boxes.

## Rejected as over-spec for hackathon
Full custody/refund/challenge protocols, maintenance-deposit economics, provenance-audit bundle as
MVP code. Correct directions; roadmap, not the timebox.

Raw review: session `019ed122` (codex exec, read-only).
