import {
  type Decisions,
  type OnboardEngine,
  type OnboardError,
  type OnboardInput,
  type OnboardOptions,
  type OnboardResult,
  assemble,
} from "./assemble";
/**
 * Deterministic onboarding — build a working Tap config from an inferred schema, NO LLM.
 *
 * This is the spine. Given the file's columns (DuckDB `describe()`), the right query interface is
 * mechanical: every column is filterable with type-appropriate operators, selectable, and sortable;
 * required columns get a `NOT NULL` invariant. No judgment, no model, fully reproducible.
 *
 * The LLM path (`onboard()` in ./onboard) is an OPTIONAL refinement on top of this — it prunes
 * filters that don't make sense and adds richer invariants/golden cases. It is never load-bearing:
 * `deriveConfig()` alone yields an eval-passed `ValidatedConfig`.
 */
import type { FieldSpec, FieldType, FilterOp } from "./config";
import { parseConfig } from "./config";
import { validate } from "./evals";
import type { EvalEngine } from "./evals";
import { type Result, err, ok } from "./result";

/** Filter operators that are meaningful per column type. JSON columns are not filterable. */
const OPS_BY_TYPE: Record<FieldType, FilterOp[]> = {
  string: ["eq", "ne", "in", "like"],
  integer: ["eq", "ne", "lt", "lte", "gt", "gte", "in"],
  number: ["eq", "ne", "lt", "lte", "gt", "gte", "in"],
  boolean: ["eq", "ne"],
  timestamp: ["eq", "ne", "lt", "lte", "gt", "gte"],
  json: [],
};

/**
 * The deterministic equivalent of the LLM's `Decisions` — derived purely from the schema.
 * Pure function: same schema → same decisions, no I/O.
 */
export function deriveDecisions(name: string, schema: FieldSpec[]): Decisions {
  const filters = schema
    .filter((f) => OPS_BY_TYPE[f.type].length > 0)
    .map((f) => ({ field: f.name, ops: OPS_BY_TYPE[f.type] }));
  const sortable = schema.filter((f) => f.type !== "json").map((f) => f.name);
  // Only required columns get a NOT NULL tripwire — we never invent ranges/semantics without a model.
  const invariants = schema.filter((f) => f.required).map((f) => `"${f.name}" IS NOT NULL`);

  return {
    query: { filters, selectable: "*", sortable, maxLimit: 1000, defaultLimit: 100 },
    unitDefinition: `one row of ${name}`,
    golden: [],
    invariants,
  };
}

/**
 * Profile the file and assemble an eval-passed config with zero LLM involvement. Mirrors `onboard()`
 * but with deterministic decisions and no retry loop (deterministic decisions either pass or the data
 * itself is the problem).
 */
export async function deriveConfig(
  input: OnboardInput,
  deps: { engine: OnboardEngine },
  opts: OnboardOptions = {},
): Promise<Result<OnboardResult, OnboardError>> {
  const { engine } = deps;

  let schema: FieldSpec[];
  try {
    schema = await engine.describe(input.source);
  } catch (e) {
    return err({ stage: "describe", issues: [e instanceof Error ? e.message : String(e)] });
  }
  if (schema.length === 0) return err({ stage: "describe", issues: ["source has no columns"] });

  const decisions = deriveDecisions(input.name, schema);
  const base = parseConfig(assemble(input, schema, decisions, opts));
  if (!base.ok) {
    return err({
      stage: "config",
      issues: base.error.issues.map((i) => `${i.path}: ${i.message}`),
    });
  }

  // Add one non-vacuous tripwire: a max-limit query must keep returning the same row count. Catches
  // source truncation/corruption — without it, deterministic evals lean entirely on coverage+schema.
  let golden = decisions.golden;
  try {
    const total = await engine.totalRows(base.value);
    const expectRowCount = Math.min(total, base.value.query.maxLimit);
    golden = [{ request: { limit: base.value.query.maxLimit }, expectRowCount }];
  } catch {
    /* if we can't count, ship without the tripwire rather than fail onboarding */
  }

  const parsed = parseConfig(assemble(input, schema, { ...decisions, golden }, opts));
  if (!parsed.ok) {
    return err({
      stage: "config",
      issues: parsed.error.issues.map((i) => `${i.path}: ${i.message}`),
    });
  }

  const result = await validate(parsed.value, engine as EvalEngine);
  if (!result.ok) {
    const failures = result.report.results
      .filter((r) => !r.passed)
      .map((r) => `${r.name}: ${r.detail}`);
    return err({ stage: "evals", issues: failures });
  }
  return ok({ config: result.config, schema, report: result.report, attempts: 1 });
}
