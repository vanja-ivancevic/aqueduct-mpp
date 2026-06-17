/**
 * The Tap config — the single source of truth for a Tap's *behavior* (CLAUDE.md invariant 2).
 *
 * MVP scope: **static structured files (parquet | csv | json), served via DuckDB.** The onboarding
 * LLM profiles a file and authors this config; the runtime executes it. Nothing here is logic — it
 * is a frozen, versioned description of: where the file is, its schema, the *constrained query
 * interface* agents may use, pricing, caching, evals, self-heal, and settlement.
 *
 * Validity is two-staged on purpose:
 *   unknown ──parseConfig──▶ TapConfig (structurally + semantically sound, NOT eval-passed)
 *   TapConfig ──eval gate (Step 3)──▶ ValidatedConfig (eval-passed; the ONLY type the runtime serves)
 *
 * The `ValidatedConfig` brand makes "served an un-evaluated config" unrepresentable.
 */
import { z } from "zod";
import { type Result, err, ok } from "./result";

// ── primitive value shapes ──────────────────────────────────────────────────
/** Money is a decimal *string*, never a float. e.g. "0.0001". */
const Decimal = z.string().regex(/^\d+(\.\d+)?$/, "decimal string, e.g. 0.0001");
/** A 20-byte hex address: TIP-20 token or payout recipient on Tempo. */
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte address");
/** Duration like "24h", "15m", "1h30m". */
const Duration = z.string().regex(/^(\d+[smhd])+$/, "duration, e.g. 24h");
/** Reference to an env var holding a secret — never an inline secret. */
const EnvRef = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "UPPER_SNAKE env var name");

// ── source contract (the declared basis for any correctness claim — CLAUDE.md scope) ─────────────
// MVP serves static deterministic files, so the contract is just: which determinism class, and how
// fresh the snapshot is. Volatility/identity/comparison strategies arrive with volatile sources
// (roadmap), not before — declaring fields the runtime ignores would be dishonest.
export const DeterminismClass = z.enum(["deterministic", "volatile", "personalized"]);
export const SourceContract = z.object({
  determinism: DeterminismClass,
  /** How long a fetched snapshot is considered current (advertised staleness bound). */
  freshnessWindow: Duration,
});

// ── source: a static structured file (MVP scope) ─────────────────────────────
export const FileFormat = z.enum(["parquet", "csv", "json"]);
export type FileFormat = z.infer<typeof FileFormat>;

/**
 * Best-effort source format from a filename or URL extension. `null` means "can't tell" — the caller
 * should require an explicit format. Pure string work (no I/O), so it lives in core. Handles URLs with
 * a trailing `?query`/`#fragment`.
 */
export function inferFormat(file: string): FileFormat | null {
  const ext = file.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
  switch (ext) {
    case "parquet":
      return "parquet";
    case "csv":
    case "tsv":
      return "csv";
    case "json":
    case "ndjson":
    case "jsonl":
      return "json";
    default:
      return null;
  }
}

export const Source = z.object({
  format: FileFormat,
  /** Where the file lives. `url` → HTTP GET; `path` → local/snapshot. */
  location: z.object({ via: z.enum(["url", "path"]), ref: z.string().min(1) }),
  /** Env var name for an upstream credential (e.g. a signed-URL header), or null. */
  authEnv: EnvRef.nullable().default(null),
  contract: SourceContract,
});

// ── normalized output schema (the file's columns) ────────────────────────────
export const FieldType = z.enum(["string", "integer", "number", "boolean", "timestamp", "json"]);
export const FieldSpec = z.object({
  name: z.string().min(1),
  type: FieldType,
  required: z.boolean().default(true),
});
export const OutputSchema = z.array(FieldSpec).min(1);
export type FieldType = z.infer<typeof FieldType>;
export type FieldSpec = z.infer<typeof FieldSpec>;
export type Source = z.infer<typeof Source>;

// ── constrained query interface (agents never send raw SQL) ──────────────────
// The runtime composes a parameterized DuckDB query from a validated agent request against THIS
// interface: SELECT <selectable> FROM <file> WHERE <filters> ORDER BY <sortable> LIMIT <=maxLimit.
export const FilterOp = z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"]);
export type FilterOp = z.infer<typeof FilterOp>;
export const QueryFilter = z.object({ field: z.string().min(1), ops: z.array(FilterOp).min(1) });
export const QueryInterface = z.object({
  filters: z.array(QueryFilter).default([]),
  /** Columns an agent may request; "*" = all declared schema fields. */
  selectable: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]).default("*"),
  sortable: z.array(z.string().min(1)).default([]),
  maxLimit: z.number().int().positive(),
  defaultLimit: z.number().int().positive(),
});
export type QueryInterface = z.infer<typeof QueryInterface>;

// ── pricing (price by a declared cost unit) ──────────────────────────────────
// Only what governs the charge: the unit, what one unit means, the price, and the settlement token.
// (Cost/margin breakdowns are the operator's business, not Tap behavior, so they live nowhere here.)
export const CostUnit = z.enum(["row", "page", "query", "byte", "result-set"]);
export const Pricing = z.object({
  unit: CostUnit,
  unitDefinition: z.string().min(1),
  unitPrice: Decimal,
  currency: Address,
});

// ── cache (named runtime state, not hidden — CLAUDE.md invariant 3) ──────────
export const Cache = z.object({ key: z.literal("queryHash"), ttl: Duration });

// ── evals (one suite; gates onboarding + repairs + publishes score) ──────────
// Implemented checks: coverage (source has rows), schema (a sample conforms to declared types),
// golden (pinned row-counts), invariants (SQL holds for every row). Only `sampleSize` is tunable;
// the rest are always-on. Source-agreement across refreshes is roadmap (trivial within one snapshot).
export const Evals = z.object({
  // a pinned agent request whose result row-count must stay stable (a deterministic tripwire)
  golden: z
    .array(
      z.object({
        request: z.record(z.string(), z.unknown()),
        expectRowCount: z.number().int().min(0),
      }),
    )
    .default([]),
  // operator-authored SQL boolean expressions that must hold for every row (frozen, trusted)
  invariants: z.array(z.string()).default([]),
  /** Rows sampled for the schema-conformance check. */
  sampleSize: z.number().int().positive().default(20),
});

// ── settlement (MVP: MPP sessions on Tempo) ──────────────────────────────────
export const Mpp = z.object({
  intent: z.literal("session"),
  recipient: Address,
  currency: Address,
  feePayer: z.boolean().default(true),
});

// ── the whole config ────────────────────────────────────────────────────────
export const TapConfigSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case identifier"),
  source: Source,
  schema: OutputSchema,
  query: QueryInterface,
  pricing: Pricing,
  cache: Cache,
  evals: Evals,
  mpp: Mpp,
});

/** A structurally + semantically valid config. NOT yet eval-passed — cannot be served. */
export type TapConfig = z.infer<typeof TapConfigSchema>;

declare const validated: unique symbol;
/** A config that has passed the eval gate. The ONLY type the runtime executor accepts. */
export type ValidatedConfig = TapConfig & { readonly [validated]: true };

export type ConfigIssue = { path: string; message: string };
export type ConfigError = { issues: ConfigIssue[] };

/**
 * Structural + cross-field parse. Does NOT run evals (that's the eval gate, Step 3), so it returns a
 * plain `TapConfig`, never a `ValidatedConfig`. Errors are returned as located issues.
 */
export function parseConfig(input: unknown): Result<TapConfig, ConfigError> {
  const parsed = TapConfigSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const semantic = checkSemantics(parsed.data);
  return semantic.length > 0 ? err({ issues: semantic }) : ok(parsed.data);
}

/** Cross-field invariants zod can't express field-locally. */
function checkSemantics(c: TapConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const fields = new Set(c.schema.map((f) => f.name));
  const mustBeField = (name: string, path: string) => {
    if (!fields.has(name))
      issues.push({ path, message: `'${name}' is not a declared schema field` });
  };

  for (const f of c.query.filters) mustBeField(f.field, "query.filters");
  for (const s of c.query.sortable) mustBeField(s, "query.sortable");
  if (c.query.selectable !== "*") {
    for (const s of c.query.selectable) mustBeField(s, "query.selectable");
  }
  if (c.query.defaultLimit > c.query.maxLimit) {
    issues.push({ path: "query.defaultLimit", message: "defaultLimit must be <= maxLimit" });
  }
  // A zero price yields an amount-0 MPP session (which the protocol rejects) — a paid Tap can't be
  // free. `unitPrice` is a validated decimal string (`^\d+(\.\d+)?$`); it's > 0 iff it carries a
  // nonzero digit. Test the string, not `Number()` — tiny prices like "0.0000001" must not underflow.
  if (!/[1-9]/.test(c.pricing.unitPrice)) {
    issues.push({ path: "pricing.unitPrice", message: "unitPrice must be greater than 0" });
  }
  return issues;
}

/**
 * Brand a parsed config as eval-passed.
 *
 * INVARIANT: the eval gate (Step 3) is the ONLY legitimate caller, and only with real passing
 * evidence. It lives here so the brand is unforgeable elsewhere in the codebase.
 */
export function markValidated(config: TapConfig): ValidatedConfig {
  return config as ValidatedConfig;
}
