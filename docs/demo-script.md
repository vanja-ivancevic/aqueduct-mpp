# Aqueduct — 3-minute demo script & runbook

Spoken narration + on-screen beats for the video. Target **2:45**. Every number on screen is from a
**real measured run** (`scripts/demo.ts` + `scripts/refresh-doaj.ts`) — nothing staged.

## How to drive the screen

The demo is a *movie* you advance beat-by-beat so it tracks your voice.

```bash
npm run demo:replay              # MANUAL — press SPACE (or →) to reveal each beat as you speak
npm run demo:replay -- --auto              # AUTO  — beats self-advance on a ~2:45 timer
npm run demo:replay -- --auto --speed 1.2  # AUTO, 1.2× faster (tune to your pace)
```

Manual keys: **SPACE / ENTER / →** next · **b / ←** redo last beat · **q / Ctrl-C** quit.
The grey `🎤 say ┃ …` line under each beat is your cue — read it, then press SPACE for the next reveal.

**Recommended:** rehearse with `--auto` to feel the pacing, then record in **manual** so the typing
lines land exactly on your words.

## How to record

**Record with `--clean`** — it hides the on-screen `🎤 say` cues (you're recording the video; the cue
text can't be in it). Keep *this script* open on a second screen / phone and read from it as you pace.

```bash
# Manual (recommended): record your terminal while you advance beats with SPACE, in time with your voice.
npm run demo:replay -- --clean

# Or asciinema (crisp terminal capture), then play back / screen-record:
asciinema rec aqueduct.cast -c "npm run demo:replay -- --clean --auto"
asciinema play aqueduct.cast            # review
```

Rehearse with cues (`npm run demo:replay`, no `--clean`); record without them. Use a dark theme,
~110×34 terminal, large font.

## Re-capturing the real numbers

The movie (`recordings/demo-movie.json`) holds the measured results. To regenerate from a fresh live
run: `npm run demo` (spawns the two real agents, ~5 min) and update the figures if they shift.

---

## The script

### ACT 1 · the problem — *~30s*

> **🎤** "The open web runs on a quiet army of free databases. DOAJ — the Directory of Open Access
> Journals — indexes twenty-three thousand of them. It's a small non-profit."

> **🎤** "In 2025, AI crawlers hammered it so hard — traffic up nine hundred and sixty-eight percent in
> a single day — that it had to hide behind a wall. The problem: that wall now blocks legitimate AI
> agents too."

> **🎤** "Watch. An agent asks DOAJ for the data directly, and gets a 403. The door is closing on the
> very people open data was meant to serve."
> *(on screen: `curl doaj.org/csv` → 403 Cloudflare)*

### ACT 2 · the builder — *~45s*

> **🎤** "Aqueduct fixes this from the supply side. The builder downloads the data once — past the
> wall, like a human would — and runs a single command."
> *(on screen: `aqueduct onboard doaj-journals.csv`)*

> **🎤** "It profiles the file, builds a safe query interface, and runs an eval gate — no model, fully
> deterministic. Twenty-three thousand journals become a Tap."
> *(on screen: normalizing → 22,940 journals → 3/3 evals passed)*

> **🎤** "That's the whole job. No server to write, no pipeline to babysit. They serve it — and now
> they have a metered, agent-payable API that takes the load off their origin and pays them per query."
> *(on screen: Tap live on :8402 · /schema free · /query $0.0001/row)*

### ACT 3 · the race — *~70s*

> **🎤** "Now the payoff. Same question, same model, two agents. A researcher's question: find a free,
> fast, peer-reviewed medical journal to publish in. One agent has the Aqueduct Tap. The other is on
> its own."

> **🎤** "On its own, the agent runs straight into the wall. The bulk CSV — blocked. The API — blocked.
> It tries the harvesting endpoint, a scraping tool, a web fetch..."
> *(on screen: 403 · 403 · 403 · antibot · 403)*

> **🎤** "Every door is shut. After four and a half minutes, twenty-six turns, and a dollar fifty of
> compute, it gives up and guesses from memory. And the answer is wrong."
> *(on screen: wrong answer · 285s · $1.51 · BLOCKED)*

> **🎤** "The Aqueduct agent never touches DOAJ. It reads the Tap's schema, writes one constrained
> query, pays a fraction of a cent per row over MPP, and answers correctly — in under a minute."
> *(on screen: correct answer · 56s · $0.28 · paid over MPP)*

> **🎤** "Five times faster. Five times cheaper. And the difference between a correct answer and a
> confident hallucination — decided entirely by whether the agent could reach clean, complete data."
> *(on screen: side-by-side result table)*

### ACT 4 · the close — *~20s*

> **🎤** "Here's the trick: we don't sell the data. The data is free. We sell never having to host it,
> refresh it, or get crushed by it — and a metered side-door that pays the operator while serving the
> agent."

> **🎤** "Alchemy for the open-data long tail. Paid per query, agent-native, settled on Tempo.
> Aqueduct."
