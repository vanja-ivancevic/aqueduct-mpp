CODE-QUALITY / OPTIMIZATION REVIEW — Aqueduct (MPP/Tempo hackathon, infra track)

You are a senior engineer reviewing for ELEGANCE, SIMPLICITY, and OPTIMIZATION — not security (that
was a separate pass). The project's north star (CLAUDE.md): "Clarity beats cleverness. Small beats
clever-small. Boring beats novel. A reviewer should understand any file in one read." Optimize in
order: correctness → legibility → hot-path speed → everything else.

Goal: find where the code is NOT as clean, simple, or well-factored as it should be, and where it
could be smarter WITHOUT sacrificing legibility. Be concrete: file:line + the better version.

Look for, ranked by impact:
1. REDUNDANCY / DUPLICATION — repeated logic that should be one function; parallel code that drifted.
2. OVER- or PREMATURE ABSTRACTION — interfaces with one impl and no second caller; indirection that
   doesn't earn its keep. (Exception: the 3 adapter interfaces LlmProvider/SourceAdapter/EvalEngine
   are deliberate invariants — don't flag those.)
3. GOD-FILES / MIXED CONCERNS — a file doing several things that should be split.
4. NAMING — names that don't say intent; type-y names instead of intent-y names.
5. HOT-PATH EFFICIENCY — the request path is runtime/server.ts GET /query → planQuery →
   cacheKey/cache → countMatching → charge → engine.query → cache.set → serve. Any wasted work,
   re-computation, avoidable allocation, or O(dataset) work per request? (But don't micro-optimize
   cold paths at the cost of clarity.)
6. DEAD CODE / UNUSED EXPORTS — anything exported but never imported; unreachable branches.
7. SMARTER-BUT-STILL-LEGIBLE rewrites — places a cleaner data structure, a stdlib feature, or a small
   type change would make the code shorter AND clearer.
8. TYPE SAFETY — "make illegal states unrepresentable" opportunities being missed; `unknown`/`any`
   that could be tightened; missing exhaustiveness.

Files to review (read them — TypeScript, strict):
- core/config.ts        (zod schema + ValidatedConfig brand + parseConfig/checkSemantics)
- core/query.ts         (planQuery — the security perimeter, request → abstract plan)
- core/pricing.ts       (BigInt money math)
- core/evals.ts         (eval engine over an injected EvalEngine)
- core/onboard.ts       (LLM onboarding pipeline + assemble)
- core/defaults.ts      (deterministic config generator)
- core/result.ts        (Result type)
- adapters/source/duckdb.ts  (DuckDB adapter — the only SQL)
- adapters/llm/cli.ts        (claude/codex LlmProvider)
- runtime/server.ts     (Hono server — the hot path)
- runtime/cache.ts      (query result cache)
- cli/index.ts          (CLI)
- index.ts              (public API barrel)

For each finding give: [HIGH/MED/LOW] impact, file:line, what's wrong (1 line), and the concrete
better version (a snippet or precise change). Prioritize a handful of high-impact simplifications over
a long list of nitpicks. End with: the single most valuable refactor, and an honest assessment of
whether the codebase already meets its "understand any file in one read" bar (yes/no + why).
Verified observations only — read the actual code, don't speculate.
