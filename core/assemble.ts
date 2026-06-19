/**
 * Config assembly — the neutral builder shared by BOTH onboarding paths.
 *
 * The deterministic path (`./defaults`) and the LLM-refined path (`./onboard`) differ only in WHO
 * authors the `Decisions` (a pure function of the schema vs. one model call). Everything downstream —
 * the inputs the builder must not invent, the tunable options, and the final merge into a config
 * object — is identical. It lives here so the no-LLM spine never has to import the LLM pipeline
 * (the deterministic path carries no LLM concern).
 */
import { z } from "zod";
import { type FieldSpec, QueryInterface, type Source, type ValidatedConfig } from "./config";
import { durationMs } from "./duration";
import type { EvalEngine, EvalReport } from "./evals";

// ── the profiling capability both paths need (injected — invariant 6) ────────
/** Eval I/O plus the two profilers onboarding uses to read a file's shape. Implemented by DuckDB. */
export interface OnboardEngine extends EvalEngine {
  /** Infer the file's columns + types without reading data. */
  describe(source: Source): Promise<FieldSpec[]>;
  /** Pull up to `n` raw sample rows for inspection. */
  sampleRaw(source: Source, n: number): Promise<Record<string, unknown>[]>;
}

// ── the config decisions (authored by deriveDecisions OR the LLM) ────────────
const GoldenCase = z.object({
  request: z.record(z.string(), z.unknown()),
  expectRowCount: z.number().int().min(0),
});
export const Decisions = z.object({
  /** The constrained query interface agents may use (filters / selectable / sortable / limits). */
  query: QueryInterface,
  /** Human-readable definition of one priced unit (e.g. "one city row"). */
  unitDefinition: z.string().min(1),
  /** Pinned request → row-count tripwires (optional; stabilize correctness across refreshes). */
  golden: z.array(GoldenCase).default([]),
  /** SQL boolean expressions that must hold for every row (optional). */
  invariants: z.array(z.string()).default([]),
});
export type Decisions = z.infer<typeof Decisions>;

// ── builder-supplied facts neither path should invent ────────────────────────
export type OnboardInput = {
  /** kebab-case Tap name. */
  name: string;
  /** Where the file lives + its determinism contract (builder declares these). */
  source: Source;
  /** Payout address on Tempo. */
  recipient: string;
  /** Settlement token (TIP-20 address; defaults to pathUSD at the CLI layer). */
  currency: string;
};

export type OnboardOptions = {
  unitPrice?: string;
  cacheTtl?: string;
  sampleSize?: number;
  maxAttempts?: number;
};

export const DEFAULTS = {
  unitPrice: "0.0001",
  cacheTtl: "1h",
  sampleSize: 20,
  maxAttempts: 3,
};

export type OnboardError = {
  stage: "describe" | "llm" | "decisions" | "config" | "evals";
  issues: string[];
};
export type OnboardResult = {
  config: ValidatedConfig;
  schema: FieldSpec[];
  report: EvalReport;
  attempts: number;
};

/** Cache TTL clamped to the source's freshness window — a served result can never be staler than the
 * window the builder advertises (enforced as a config invariant; clamped here so onboarding can't trip it). */
function clampTtl(ttl: string, source: Source): string {
  const window = source.contract.freshnessWindow;
  return durationMs(ttl) <= durationMs(window) ? ttl : window;
}

/** Merge the builder's facts + inferred schema + decisions into a full (unvalidated) config object. */
export function assemble(
  input: OnboardInput,
  schema: FieldSpec[],
  decisions: Decisions,
  opts: OnboardOptions,
): unknown {
  return {
    version: 1,
    name: input.name,
    source: input.source,
    schema,
    query: decisions.query,
    pricing: {
      unit: "row",
      unitDefinition: decisions.unitDefinition,
      unitPrice: opts.unitPrice ?? DEFAULTS.unitPrice,
      currency: input.currency,
    },
    // The cache may not outlive the advertised freshness window (config invariant). A sub-window
    // freshness (e.g. "5m" for a minute-cadence feed) clamps the default TTL down, so onboarding
    // always yields a valid config instead of erroring on the default.
    cache: { key: "queryHash", ttl: clampTtl(opts.cacheTtl ?? DEFAULTS.cacheTtl, input.source) },
    evals: {
      golden: decisions.golden,
      invariants: decisions.invariants,
      sampleSize: opts.sampleSize ?? DEFAULTS.sampleSize,
    },
    mpp: {
      intent: "session",
      recipient: input.recipient,
      currency: input.currency,
      feePayer: true,
    },
  };
}
