/**
 * Query planner — the security perimeter.
 *
 * Takes an UNTRUSTED agent request and a Tap config, and produces an abstract `QueryPlan` only if the
 * request stays entirely within the config's declared query interface (filters/selectable/sortable/
 * limits). Anything undeclared is rejected, not silently dropped — an agent paying per row deserves a
 * clear error, not surprise results.
 *
 * Pure + engine-agnostic: no I/O, no DuckDB, no SQL. The plan is abstract data; the `SourceAdapter`
 * (DuckDB) compiles it to *parameterized* SQL downstream. This file is what makes raw/injected SQL
 * unrepresentable — values never become SQL here, they stay as plan data.
 */
import { z } from "zod";
import { type FieldType, FilterOp, type TapConfig } from "./config";
import { type Result, err, ok } from "./result";

// ── hard caps on an untrusted request (bound the work an unpaid request can force) ───────────────
const MAX_SELECT = 128; // columns requested
const MAX_FILTERS = 32; // predicates
const MAX_SORT = 16; // sort keys
const MAX_IN = 100; // values in an `in` list
const MAX_VALUE_CHARS = 512; // length of a string/timestamp/like value
const MAX_OFFSET = 100_000_000; // pagination ceiling (also keeps offset a sci-notation-free integer)

// ── the untrusted agent request (shape-validated before semantic checks) ─────
export const AgentRequestSchema = z.strictObject({
  select: z.array(z.string()).min(1).max(MAX_SELECT).optional(),
  filters: z
    .array(z.object({ field: z.string(), op: FilterOp, value: z.unknown() }))
    .max(MAX_FILTERS)
    .optional(),
  sort: z
    .array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).default("asc") }))
    .max(MAX_SORT)
    .optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

// ── the abstract, engine-agnostic plan (compiled to parameterized SQL by the adapter) ───────────
// `columns` is always an explicit, declared-schema list — never `*` — so a query can never return a
// physical column the config's schema omits (security: undeclared-column leak).
export type QueryPlan = {
  columns: string[];
  predicates: { field: string; op: FilterOp; value: unknown }[];
  order: { field: string; dir: "asc" | "desc" }[];
  limit: number;
  offset: number;
};

export type QueryIssue = { path: string; message: string };
export type QueryError = { issues: QueryIssue[] };

/**
 * The config's query interface, compiled into lookup structures once. Rebuilding these Maps/Sets per
 * request is pure waste on the hot path — the config is immutable, so the server computes this at
 * startup (`queryPolicy(config)`) and hands it to every `planQuery` call.
 */
export type QueryPolicy = {
  fieldType: Map<string, FieldType>;
  /** Columns an agent may select; `"*"` = all declared schema fields (resolved in `allSelectable`). */
  selectable: "*" | Set<string>;
  allowedOps: Map<string, Set<FilterOp>>;
  sortable: Set<string>;
  /** The explicit column list `"*"` expands to — never `*` downstream. */
  allSelectable: string[];
};

export function queryPolicy(config: TapConfig): QueryPolicy {
  const selectable: "*" | Set<string> =
    config.query.selectable === "*" ? "*" : new Set(config.query.selectable);
  return {
    fieldType: new Map(config.schema.map((f) => [f.name, f.type] as const)),
    selectable,
    allowedOps: new Map(config.query.filters.map((f) => [f.field, new Set(f.ops)] as const)),
    sortable: new Set(config.query.sortable),
    allSelectable: selectable === "*" ? config.schema.map((f) => f.name) : [...selectable],
  };
}

/**
 * Validate an untrusted agent request against the config and return an abstract plan, or located
 * issues. Never throws; never emits SQL. Pass a precomputed `policy` on the hot path; cold callers
 * (evals, tests) may omit it and it's derived per call.
 */
export function planQuery(
  config: TapConfig,
  rawRequest: unknown,
  policy: QueryPolicy = queryPolicy(config),
): Result<QueryPlan, QueryError> {
  const parsed = AgentRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return err({
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const req = parsed.data;
  const issues: QueryIssue[] = [];

  const { fieldType, selectable, allowedOps, sortable, allSelectable } = policy;

  // ── columns ── always an explicit declared list; "*" means "all declared schema fields", which we
  // resolve here so the SQL never selects a physical column the schema omits.
  let columns: string[];
  if (req.select !== undefined) {
    for (const col of req.select) {
      if (!fieldType.has(col))
        issues.push({ path: "select", message: `'${col}' is not a schema field` });
      else if (selectable !== "*" && !selectable.has(col)) {
        issues.push({ path: "select", message: `'${col}' is not selectable` });
      }
    }
    columns = req.select;
  } else {
    columns = allSelectable;
  }

  // ── filters ──
  const predicates: QueryPlan["predicates"] = [];
  for (const f of req.filters ?? []) {
    const ops = allowedOps.get(f.field);
    if (!ops) {
      issues.push({ path: "filters", message: `field '${f.field}' is not filterable` });
      continue;
    }
    if (!ops.has(f.op)) {
      issues.push({ path: "filters", message: `op '${f.op}' not allowed on '${f.field}'` });
      continue;
    }
    const t = fieldType.get(f.field);
    const valueIssue = checkValue(f.field, f.op, f.value, t);
    if (valueIssue) issues.push(valueIssue);
    else predicates.push({ field: f.field, op: f.op, value: f.value });
  }

  // ── sort ──
  const order: QueryPlan["order"] = [];
  for (const s of req.sort ?? []) {
    if (!sortable.has(s.field)) {
      issues.push({ path: "sort", message: `field '${s.field}' is not sortable` });
      continue;
    }
    order.push({ field: s.field, dir: s.dir });
  }

  if (issues.length > 0) return err({ issues });

  // ── limits (clamp, don't reject — friendlier; maxLimit/MAX_OFFSET are the hard caps) ──
  const limit = Math.min(req.limit ?? config.query.defaultLimit, config.query.maxLimit);
  const offset = Math.min(req.offset ?? 0, MAX_OFFSET);

  return ok({ columns, predicates, order, limit, offset });
}

/** Light value/type guard so the plan carries sane values. Returns an issue or null. */
function checkValue(
  field: string,
  op: FilterOp,
  value: unknown,
  type: FieldType | undefined,
): QueryIssue | null {
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0) {
      return { path: "filters", message: `'in' on '${field}' needs a non-empty array` };
    }
    if (value.length > MAX_IN) {
      return { path: "filters", message: `'in' on '${field}' exceeds ${MAX_IN} values` };
    }
    for (const v of value) {
      const issue = scalarIssue(field, v, type);
      if (issue) return issue;
    }
    return null;
  }
  if (op === "like" && type !== "string") {
    return { path: "filters", message: `'like' only applies to string field '${field}'` };
  }
  if (value === undefined || value === null) {
    return { path: "filters", message: `'${field}' filter value is missing` };
  }
  return scalarIssue(field, value, type);
}

/** Type + bound + format guard for a single scalar value. */
function scalarIssue(
  field: string,
  value: unknown,
  type: FieldType | undefined,
): QueryIssue | null {
  if (!typeOk(value, type)) return { path: "filters", message: `'${field}' value has wrong type` };
  if (typeof value === "string" && value.length > MAX_VALUE_CHARS) {
    return { path: "filters", message: `'${field}' value exceeds ${MAX_VALUE_CHARS} chars` };
  }
  // a timestamp must actually parse — else DuckDB's CAST throws at query time (an unpaid 500)
  if (type === "timestamp" && Number.isNaN(Date.parse(value as string))) {
    return { path: "filters", message: `'${field}' is not a valid timestamp` };
  }
  return null;
}

function typeOk(value: unknown, type: FieldType | undefined): boolean {
  switch (type) {
    case "string":
    case "timestamp": // ISO-8601 string
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default: // json or undefined — accept
      return true;
  }
}
