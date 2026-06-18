# Cost benchmark: Aqueduct vs Claude Code from scratch

**The judge's challenge:** Claude Code can already fetch data and answer questions autonomously. Where
does Aqueduct actually win on *cost*? We measured it.

## Setup

- **Dataset:** NYC TLC yellow-taxi parquet, Jan 2024 — **2,964,624 rows**, served remotely via DuckDB
  (no download; HTTP range reads). Onboarded as a Tap **deterministically — $0 LLM**, 3/3 evals.
- **Both arms:** same model (`claude-opus-4-8`), headless via the `claude` CLI (reports tokens + USD).
  - **Arm A — from scratch:** given the dataset URL + a computer, writes & runs DuckDB code.
  - **Arm B — Aqueduct Tap:** reads the Tap schema, forms ONE constrained query, runs it deterministically.
- 4 needle-in-haystack questions; correctness vs DuckDB ground truth. Harness: `scripts/bench-run.ts`.

## Result (4 questions)

| | Arm A (scratch) | Arm B (Tap, agent) |
|---|--:|--:|
| total cost | **$0.86** | $1.34 |
| tokens | 590k | 871k |
| correct | 4/4 | 4/4 |
| per-question | $0.11–0.52 | $0.14–0.88 |

**Both got every answer right. Arm A (Claude Code from scratch) was *cheaper*, not more expensive.**

## Why — and the honest takeaway

The judge is right for this shape of task. Handing Claude Code a known parquet URL and "use DuckDB" is
a well-trodden path it nails in **2 turns / ~$0.11**. Putting an *agent* in front of an Aqueduct Tap
doesn't beat that — the agent still costs LLM tokens to read the schema and form a query, plus tool
overhead. **Aqueduct does not win on "an agent answering one question."**

Two things the numbers also show:

1. **Claude Code is high-variance.** Arm A ranged $0.11 → **$0.52** (5×) on `longest-trip`, where it hit
   a confusing value and iterated 14 turns. Determinism has value the mean hides.
2. **The agent cost dominates both arms.** The Tap's *data plane* answered each query for **$0.0001–
   0.0026 and $0 LLM** — but that saving is swamped by the ~$0.10+ the consuming LLM spends either way.

## Where Aqueduct actually wins (and what to measure next)

The benchmark measured the wrong axis: **one-shot agent cost**. Aqueduct's value is not replacing the
agent — it's removing the LLM from the *repeat* path:

- **Volume / amortization.** The LLM forms a query (or onboards) **once**. Serving that query the 2nd…
  Nth time costs **$0 LLM + $0.0001/row**, deterministic. Answer one query 1,000×:
  Claude-Code ≈ 1,000 × $0.11 = **$110**; Tap ≈ **$0.10**. The gap is entirely in not re-invoking an LLM.
- **Determinism & no hallucination.** Same query → same rows, always. (Our exoplanet demo showed Claude
  confabulating radii from memory; a Tap can't.)
- **Discovery cost (unmeasured here — we handed Arm A the URL).** Real questions don't ship with the
  right URL/schema. Make the agent *find* the dataset and Arm A's cost should balloon.
- **Inaccessibility / scale.** Datasets too big to naively load, gated, or live — where Arm A's first
  code attempt fails and iterates.

**Conclusion (one-shot, public data):** Aqueduct is not "a cheaper analyst for one question." It is
**deterministic, metered, $0-LLM data *serving*** — the win is at volume and in reliability, where you
take the LLM out of the loop entirely.

## Follow-up: discovery mode (no URL handed over)

We re-ran Arm A but withheld the URL — Claude had to *find* the dataset itself ("NYC yellow taxi, Jan
2024"):

| question | known-URL | discovery (no URL) | correct |
|---|--:|--:|:-:|
| fare>1000 | $0.11 | **$0.15** (3 turns, 20s) | ✓ |
| tip>100 | $0.11 | **$0.13** (3 turns, 11s) | ✓ |

Discovery added only **~$0.03**. Claude Code *knows where famous public datasets live* (TLC, on
CloudFront) and goes straight there. So discovery doesn't break it either — **for popular, public,
accessible data, Claude Code is cheap, fast, and correct. The judge is right.**

## So where does Aqueduct actually win? (the honest strategic answer)

The "can Aqueduct answer what Claude can't" framing is the wrong axis. On **public** data it can't beat
Claude Code, and shouldn't try. Aqueduct's real position is the **supply side**:

1. **Private / proprietary data.** Claude Code can only fetch what's *already public*. A data owner's
   internal feed, a paid dataset, a live gated API — Claude literally cannot reach it. Aqueduct is the
   rails for an owner to **sell** that data to agents per-query. (Claude Code is the *buyer*; Aqueduct
   is *seller* infrastructure.)
2. **Volume / $0-LLM serving.** The LLM forms a query (or onboards) once; serving it the 2nd…Nth time
   is $0 LLM + $0.0001/row, deterministic. Answer one query 1,000×: Claude-Code ≈ $110; Tap ≈ $0.10.
3. **Determinism & no hallucination.** Same query → same rows. (The exoplanet demo's no-data baseline
   showed Claude confabulating radii from memory; a Tap can't.)

**Net:** position Aqueduct as **metered monetization infra for data *suppliers*** (the MPP/Tempo
thesis — machine-to-machine micropayments for data), not as a cheaper analyst for public data. The
benchmark is the evidence for *why* that's the right framing.
