/**
 * DuckDB SourceAdapter — compiles an abstract `QueryPlan` into PARAMETERIZED SQL and executes it.
 *
 * This is the only place SQL exists. Agent values from the plan become bound `?` parameters, never
 * string-concatenated. Column/source identifiers come from the operator's config (trusted) and are
 * still quoted defensively. `core/` never imports this — the engine lives behind the seam, so a
 * swap to SQLite touches only this file.
 */
import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBValue,
  quotedIdentifier,
  quotedString,
} from "@duckdb/node-api";
import type { OnboardEngine } from "../../core/assemble";
import type { FieldSpec, FilterOp, Source, TapConfig } from "../../core/config";
import type { EvalEngine } from "../../core/evals";
import type { QueryPlan } from "../../core/query";

// SQL operator per filter op. Typed by `FilterOp` (minus `in`, which compiles to an `IN (...)` list)
// so adding a new op to the config without a SQL mapping is a compile error, not a silent gap.
const OP_SQL: Record<Exclude<FilterOp, "in">, string> = {
  eq: "=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "LIKE",
};

/** Build a parameterized WHERE clause from validated predicates. Shared by query + count. */
function compileWhere(
  config: TapConfig,
  predicates: QueryPlan["predicates"],
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  // timestamp comparisons need an explicit cast so a string param isn't compared as text. Schemas are
  // small and predicates few, so a direct `find` beats allocating a Map per query.
  const placeholder = (field: string) =>
    config.schema.find((f) => f.name === field)?.type === "timestamp"
      ? "CAST(? AS TIMESTAMP)"
      : "?";

  const where: string[] = [];
  for (const p of predicates) {
    const id = quotedIdentifier(p.field);
    if (p.op === "in") {
      const slots = (p.value as unknown[])
        .map((v) => {
          params.push(v);
          return placeholder(p.field);
        })
        .join(", ");
      where.push(`${id} IN (${slots})`);
    } else {
      params.push(p.value);
      where.push(`${id} ${OP_SQL[p.op]} ${placeholder(p.field)}`);
    }
  }
  return { clause: where.join(" AND "), params };
}

/** Build the engine-specific, parameterized SQL for a plan. Values go in `params`, never the string. */
export function compilePlan(
  config: TapConfig,
  plan: QueryPlan,
): { sql: string; params: unknown[] } {
  const { clause, params } = compileWhere(config, plan.predicates);
  // plan.columns is always an explicit declared-schema list (planQuery never emits "*").
  const cols = plan.columns.map(quotedIdentifier).join(", ");
  const order = plan.order.map(
    (o) => `${quotedIdentifier(o.field)} ${o.dir === "desc" ? "DESC" : "ASC"}`,
  );

  let sql = `SELECT ${cols} FROM ${sourceExpr(config.source)}`;
  if (clause) sql += ` WHERE ${clause}`;
  if (order.length > 0) sql += ` ORDER BY ${order.join(", ")}`;
  // limit/offset are validated, clamped integers from the planner — safe to inline (and DuckDB is
  // finicky about binding them).
  sql += ` LIMIT ${plan.limit} OFFSET ${plan.offset}`;

  return { sql, params };
}

/** Map a config source to the DuckDB reader expression. `ref` is trusted config; quoted defensively. */
function sourceExpr(source: Source): string {
  const ref = quotedString(source.location.ref);
  switch (source.format) {
    case "parquet":
      return `read_parquet(${ref})`;
    case "csv":
      return `read_csv_auto(${ref})`;
    case "json":
      return `read_json_auto(${ref})`;
  }
}

/**
 * A long-lived DuckDB engine (one per Tap). Holds a single connection — initialize once at startup,
 * not per request (hot-path budget).
 */
export class DuckDbEngine implements EvalEngine, OnboardEngine {
  private constructor(
    private readonly conn: DuckDBConnection,
    private readonly instance: DuckDBInstance,
  ) {}

  static async create(): Promise<DuckDbEngine> {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    // Enable reading remote (url) sources. Best-effort: offline/path-only Taps don't need it, so a
    // failure here must not break local files — URL sources will surface a clear error at query time.
    try {
      await conn.run("INSTALL httpfs; LOAD httpfs;");
    } catch {
      /* httpfs unavailable (offline) — only affects url sources */
    }
    return new DuckDbEngine(conn, instance);
  }

  /** Release the connection + instance. Call for short-lived commands (onboarding); the server holds
   *  it open. `disconnectSync`/`closeSync` are part of the typed node-api surface. */
  close(): void {
    this.conn.disconnectSync();
    this.instance.closeSync();
  }

  /** Execute a validated plan; returns rows normalized to the config's declared schema types. */
  async query(config: TapConfig, plan: QueryPlan): Promise<Record<string, unknown>[]> {
    const { sql, params } = compilePlan(config, plan);
    const reader = await this.conn.runAndReadAll(sql, params as DuckDBValue[]);
    return normalizeRows(config, reader.getRowObjectsJson());
  }

  /**
   * How many rows the plan would actually RETURN (matched, then clamped by offset+limit). This is
   * the billable count — the server prices `returned × unitPrice` before charging.
   */
  async countMatching(config: TapConfig, plan: QueryPlan): Promise<number> {
    const { clause, params } = compileWhere(config, plan.predicates);
    // Count only the returned window: the inner LIMIT/OFFSET lets DuckDB stop the scan after enough
    // rows, instead of counting every match and clamping in JS. Mirrors the SELECT the server runs
    // post-charge, so the priced count and the served rows always agree.
    const sql = `SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM ${sourceExpr(config.source)}${clause ? ` WHERE ${clause}` : ""}
      LIMIT ${plan.limit} OFFSET ${plan.offset}
    )`;
    const reader = await this.conn.runAndReadAll(sql, params as DuckDBValue[]);
    return Number(reader.getRowObjectsJson()[0]?.n ?? 0);
  }

  /** COUNT(*) over the source — used by the coverage eval. */
  async totalRows(config: TapConfig): Promise<number> {
    const reader = await this.conn.runAndReadAll(
      `SELECT COUNT(*) AS n FROM ${sourceExpr(config.source)}`,
    );
    return Number(reader.getRowObjectsJson()[0]?.n ?? 0);
  }

  /** Rows violating an operator-authored SQL boolean (config is frozen/trusted, not agent input). */
  async violations(config: TapConfig, invariant: string): Promise<number> {
    const sql = `SELECT COUNT(*) AS n FROM ${sourceExpr(config.source)} WHERE NOT (${invariant})`;
    const reader = await this.conn.runAndReadAll(sql);
    return Number(reader.getRowObjectsJson()[0]?.n ?? 0);
  }

  // ── onboarding profilers (used by the onboard pipeline, NOT the hot path) ───
  /** Infer the file's columns + types by asking DuckDB to DESCRIBE a zero-row read. */
  async describe(source: Source): Promise<FieldSpec[]> {
    const reader = await this.conn.runAndReadAll(
      `DESCRIBE SELECT * FROM ${sourceExpr(source)} LIMIT 0`,
    );
    return reader.getRowObjectsJson().map((r) => ({
      name: String(r.column_name),
      type: duckTypeToFieldType(String(r.column_type)),
      required: String(r.null ?? "YES") === "NO",
    }));
  }

  /** Pull up to `n` raw sample rows (untyped) for the onboarding LLM to inspect. */
  async sampleRaw(source: Source, n: number): Promise<Record<string, unknown>[]> {
    const limit = Math.max(0, Math.floor(n));
    const reader = await this.conn.runAndReadAll(
      `SELECT * FROM ${sourceExpr(source)} LIMIT ${limit}`,
    );
    return reader.getRowObjectsJson();
  }
}

/** Map a DuckDB column type (from DESCRIBE) to our normalized FieldType. */
function duckTypeToFieldType(duckType: string): FieldSpec["type"] {
  const t = duckType.toUpperCase();
  // Compound types FIRST — their inner signature (e.g. `STRUCT(w BIGINT, ts TIMESTAMP)`) contains
  // scalar type names, so a scalar check would mis-match them (BIGINT → "integer"). A nested column
  // is delivered as a JSON object/array; we type it `json` (not filterable/sortable, just selectable).
  if (
    t.startsWith("STRUCT") ||
    t.startsWith("MAP") ||
    t.startsWith("LIST") ||
    t.startsWith("UNION") ||
    t.endsWith("[]") ||
    t === "JSON"
  )
    return "json";
  if (t.startsWith("DECIMAL") || t === "DOUBLE" || t === "FLOAT" || t === "REAL") return "number";
  if (/^U?INTEGER$|^U?(TINY|SMALL|BIG|HUGE)INT$|^INT$/.test(t)) return "integer";
  if (t === "BOOLEAN" || t === "BOOL") return "boolean";
  if (t.startsWith("TIMESTAMP") || t === "DATE" || t === "TIME") return "timestamp";
  return "string";
}

/**
 * Normalize engine output to the config's declared types.
 *
 * `getRowObjectsJson()` returns DuckDB BIGINT as a *string* (JSON can't hold bigint). We declared the
 * column's type in the config, so coerce numeric columns back to numbers. Values beyond safe-integer
 * range stay strings (precision preserved over a lossy number) — a known MVP edge.
 */
function normalizeRows(
  config: TapConfig,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  // Only numeric columns can need coercion; if there are none, the rows are already correct. The row
  // objects from `getRowObjectsJson()` are freshly allocated and ours, so we coerce in place rather
  // than rebuilding every object — no per-row Map / spread / Object.entries on the hot path.
  const numeric = config.schema.filter((f) => f.type === "integer" || f.type === "number");
  if (numeric.length === 0) return rows;
  for (const row of rows) {
    for (const f of numeric) {
      const value = row[f.name];
      if (typeof value !== "string") continue;
      const n = Number(value);
      if (Number.isSafeInteger(n) || (f.type === "number" && Number.isFinite(n))) row[f.name] = n;
    }
  }
  return rows;
}
