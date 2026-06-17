/**
 * Eval engine — one suite, three jobs: gate onboarding, gate repairs, publish a correctness score.
 *
 * Evals need to run queries (I/O), so this module stays out of `core`'s purity rule the right way:
 * it depends on an injected `EvalEngine` interface (CLAUDE.md invariant 6), not on DuckDB. The DuckDB
 * adapter implements it. The eval LOGIC here is pure orchestration over that interface.
 *
 * MVP (static files): correctness = fidelity to the source file. Implemented checks:
 *  - coverage   : source has rows (DuckDB COUNT(*) > 0)
 *  - schema     : a sample conforms to the declared types
 *  - golden     : pinned agent requests return their pinned row-count
 *  - invariants : operator SQL boolean expressions hold for every row
 * (source-agreement across refreshes = roadmap; trivial within one snapshot.)
 */
import { type FieldType, type TapConfig, markValidated } from "./config";
import { type AgentRequest, type QueryPlan, planQuery } from "./query";

/** The I/O capability evals need. Implemented by the DuckDB adapter. */
export interface EvalEngine {
  query(config: TapConfig, plan: QueryPlan): Promise<Record<string, unknown>[]>;
  totalRows(config: TapConfig): Promise<number>;
  /** Count rows violating an operator-authored SQL boolean (i.e. `COUNT(*) WHERE NOT (expr)`). */
  violations(config: TapConfig, invariant: string): Promise<number>;
}

export type EvalResult = { name: string; passed: boolean; detail: string };
export type EvalReport = { passed: boolean; score: number; results: EvalResult[] };

export async function runEvals(config: TapConfig, engine: EvalEngine): Promise<EvalReport> {
  const results: EvalResult[] = [];

  // coverage — the source actually has data
  const total = await engine.totalRows(config);
  results.push({ name: "coverage", passed: total > 0, detail: `${total} rows in source` });

  // schema — sample every declared column directly (evals bypass the agent-facing selectable allowlist)
  const sample = await engine.query(config, sampleAllColumns(config));
  results.push(checkSchema(config, sample));

  // golden — pinned requests keep their row-count
  for (const [i, g] of config.evals.golden.entries()) {
    results.push(await runGolden(config, engine, g.request, g.expectRowCount, i));
  }

  // invariants — operator SQL holds for every row
  for (const inv of config.evals.invariants) {
    const v = await engine.violations(config, inv);
    results.push({ name: "invariant", passed: v === 0, detail: `${v} rows violate: ${inv}` });
  }

  const passed = results.every((r) => r.passed);
  const score = results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length;
  return { passed, score, results };
}

/** Convenience: run evals and, only if they pass, brand the config servable. */
export async function validate(config: TapConfig, engine: EvalEngine) {
  const report = await runEvals(config, engine);
  return report.passed
    ? { ok: true as const, config: markValidated(config), report }
    : { ok: false as const, report };
}

/** A plan that reads every declared column (operator-side; not bound by `query.selectable`). */
function sampleAllColumns(config: TapConfig): QueryPlan {
  return {
    columns: config.schema.map((f) => f.name),
    predicates: [],
    order: [],
    limit: Math.max(1, config.evals.sampleSize),
    offset: 0,
  };
}

function checkSchema(config: TapConfig, rows: Record<string, unknown>[]): EvalResult {
  for (const [i, row] of rows.entries()) {
    for (const f of config.schema) {
      const v = row[f.name];
      if (v === undefined || v === null) {
        if (f.required)
          return {
            name: "schema",
            passed: false,
            detail: `row ${i}: missing required '${f.name}'`,
          };
        continue;
      }
      if (!typeMatches(v, f.type)) {
        return { name: "schema", passed: false, detail: `row ${i}: '${f.name}' is not ${f.type}` };
      }
    }
  }
  return { name: "schema", passed: true, detail: `${rows.length} sampled rows conform` };
}

async function runGolden(
  config: TapConfig,
  engine: EvalEngine,
  request: AgentRequest | Record<string, unknown>,
  expectRowCount: number,
  i: number,
): Promise<EvalResult> {
  const plan = planQuery(config, request);
  if (!plan.ok) {
    return {
      name: `golden[${i}]`,
      passed: false,
      detail: `invalid request: ${plan.error.issues[0]?.message}`,
    };
  }
  const rows = await engine.query(config, plan.value);
  return {
    name: `golden[${i}]`,
    passed: rows.length === expectRowCount,
    detail: `got ${rows.length}, expected ${expectRowCount}`,
  };
}

/** Lenient type guard — a tripwire, not a parser. Numeric strings (huge ints) accepted as numbers. */
function typeMatches(v: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
    case "timestamp":
      return typeof v === "string";
    case "integer":
      return (
        (typeof v === "number" && Number.isInteger(v)) ||
        (typeof v === "string" && /^-?\d+$/.test(v))
      );
    case "number":
      return typeof v === "number" || (typeof v === "string" && !Number.isNaN(Number(v)));
    case "boolean":
      return typeof v === "boolean";
    default: // json
      return true;
  }
}
