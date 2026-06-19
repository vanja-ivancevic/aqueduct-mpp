# Aqueduct — Live Demo Runbook

> Same agent, same task, with vs without Aqueduct. Two identical `claude` agents get one real research
> question over the DOAJ open-access journal corpus. One has an Aqueduct Tap; one is on its own and runs
> into the wall DOAJ put up to survive AI-crawler load. Same model, very different outcome — and nothing
> is staged.

## TL;DR — run it

```bash
npm install && npm run build
npm run demo            # one run: BUILD (onboard the CSV → Tap) → SERVE → RACE two live agents (~15-20 min)
npm run demo:replay     # the recorded run as a narratable "movie" for a video (instant, repeatable)
```

`npm run demo` does the whole story end to end: it onboards `examples/doaj-journals.csv` into a metered
Tap (deterministic, no LLM), serves it, then races two `claude` agents on it — **streaming each agent's
verbose thinking + tool calls live** (plain, like the normal Claude Code CLI) and writing full
transcripts to `recordings/with-aqueduct.log` and `recordings/on-its-own.log`.

`npm run demo` needs network, the public Tempo faucet (it funds throwaway wallets — no keys, no
config), and the `claude` CLI on PATH. Optional: set `AQUEDUCT_AGENT_KEY` to a funded key to skip the
faucet. A build (`npm run build`) makes the MCP server available at `dist/mcp.js`.

**For a live demo:** `npm run demo:tap` (alias for `npm run demo -- --no-solo`) runs **only** the
WITH-Aqueduct agent and skips the solo agent — the solo run can take ~15+ minutes fighting the
Cloudflare wall, which is too long on stage. You get the onboard → serve → query → paid-settlement
story in under a minute. Run the full two-agent comparison off-stage (or show the recorded video).

## What the audience sees

The task is a real researcher's question — *shortlist diamond-OA (no-APC) Medicine journals, license
CC BY, plagiarism-screened, peer review under 12 weeks, ranked by article output* — over the ~23,000
journals DOAJ indexes. It needs the **whole corpus** to answer faithfully; you can't guess it.

```
◀ WITH AQUEDUCT                           THE AGENT ON ITS OWN ▶
answer:  Memorias do Inst. Oswaldo Cruz ✓ answer:  no answer (wouldn't guess) ✗ BLOCKED
time:    32 s                             time:    17 min
agent $: $0.28  (7 turns)                 agent $: $2.59  (40 turns)
data:    one paid MPP query               data:    blocked at DOAJ (403)
→ 30× faster · 9× cheaper · correct vs blocked ✓
the Aqueduct agent paid per row over MPP (0.0114 pathUSD), settled on-chain to the publisher's wallet
```

## The honest story (why this isn't a rigged benchmark)

DOAJ is a small non-profit. In 2025 AI crawlers hit it so hard (a single day **+968%** over the prior
year) that it moved its bulk CSV **and** its REST API behind Cloudflare. That wall now blocks
legitimate AI agents too — verified live: every route an agent tries (`/csv`, `/api`, OAI-PMH,
firecrawl, WebFetch) returns `403 "Just a moment…"`.

So the "on its own" agent genuinely **cannot** get the data. Walled off, it thrashes for ~17 minutes
across every route — bulk CSV, API, OAI-PMH, the S3 cache, the Wayback Machine — gets a `403` at each,
and then stops, **refusing to fabricate** a ranking it can't verify. (On other runs it instead guesses
a journal from memory and gets it wrong — either way it never reaches the corpus.) The Aqueduct agent
never touches DOAJ: it reads the Tap's schema, issues one constrained query, pays per row over MPP, and
answers correctly.

Two guards keep it honest:
- **Each agent runs in an isolated scratch dir** — neither can read the repo's local copy of the data.
  The only routes are the Tap (network) vs. the real, walled DOAJ (network).
- **No outcome is hardcoded.** The panels render whatever the agents actually produce; the "blocked"
  label is derived from the lone agent's real answer.

## The builder side (one command)

The supply side is the point. A builder downloads DOAJ's CSV once (past the wall, like a human), then:

```bash
npm run demo:refresh -- --unit-price 0.0005 --recipient 0xYourPayout
# normalizing doaj_journalcsv_*.csv → examples/doaj-journals.csv …
#   wrote 22,940 journals
# onboarding → examples/doaj-journals.tap.json  (deterministic, no LLM) …
#   ✓ config written — 3/3 evals passed · price 0.0005/row → 0xYourPa…
```

That's the whole job — no server written, no pipeline to babysit. **The builder is the reseller:** they
set their own per-row price (`--unit-price`) and payout wallet, and keep the margin above hosting cost —
the data is free to them, the maintained *access* is the product. They serve it (`aqueduct serve`) and
now have a metered, agent-payable API that offloads their origin and pays them per query. Settlement is
agent→publisher on Tempo; Aqueduct never touches the funds. (The agent's model/compute cost is separate
and its own — the data price is purely the builder's lever.)

## Recording the video

`npm run demo:replay` is a beat-by-beat *movie* of the real run (numbers are from real measured runs)
that you pace to your narration:

```bash
npm run demo:replay                        # MANUAL — press SPACE to reveal each beat as you speak
npm run demo:replay -- --auto              # AUTO   — self-advances on a ~2:45 timer
npm run demo:replay -- --auto --speed 1.2  # AUTO, tuned faster
```

Manual keys: **SPACE/→** next · **b/←** redo · **q/Ctrl-C** quit. The grey `🎤 say` line is your cue.
Capture with `asciinema rec aqueduct.cast -c "npm run demo:replay -- --clean --auto"` or just
screen-record a manual run.

## The architecture in one glance

```
  DOAJ CSV ──refresh (DuckDB normalize, no LLM)──▶ Tap config ──serve──▶ ┌─────────────────┐
  (builder, once, past the wall)                   (frozen, validated)    │   Tap server    │
                                                                          │  GET /schema    │ free
   agent / app ──MPP session───────────────────────────────────────────▶ │  GET /query?q=  │ paid
        voucher per request, settle once on-chain (Tempo)                 └────────┬────────┘
                                                                                   │
                                     planQuery (security perimeter) ──▶ DuckDB ──▶ rows
                                     cache hit → no upstream, deterministic, <100ms
```

- **No LLM in the request path.** Onboarding (deterministic here) is the only compile step. The runtime
  that answers a paid request is pure config execution + payment.
- **The config is the single source of truth.** Frozen, versioned, validated by evals before it can be
  served (`ValidatedConfig` — un-evaluated configs are a *type error*).
- **Agents never send SQL.** A constrained query interface (declared filters/columns/sorts) compiles to
  parameterized DuckDB SQL. Values stay data; they never become SQL.

## Troubleshooting

- **"faucet unavailable"** — the public Tempo faucet was slow/unreachable. Re-run; it's idempotent. The
  comparison still prints; only the on-chain payment proof needs the faucet.
- **`claude: command not found`** — the live `npm run demo` needs the `claude` CLI on PATH. (The
  recorded `npm run demo:replay` does not.)
- **Replay animation looks garbled** — you piped it; the typing reveal needs a real terminal (TTY).

## What's real vs. scoped for the hackathon

- **Real:** the Cloudflare wall (verified live), the deterministic refresh/onboard, the constrained
  query path, the cache, per-row pricing, live MPP sessions, on-chain settlement, local ↔ Akash deploy,
  the skill + MCP server — all end-to-end. The demo numbers are from real measured runs.
- **MVP scope:** static structured files (parquet/csv/json) via DuckDB, acquired by a single GET or
  local path. Live APIs, SQL/scraped sources, and agentic ingestion of messy data are roadmap.
