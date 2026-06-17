/**
 * Aqueduct — programmatic entry point.
 *
 * The CLI (`aqueduct onboard|serve`) is the usual surface; this barrel exposes the same pieces for
 * embedding Aqueduct in your own tooling. Keep the public surface small — re-export only what a
 * consumer composes (config, onboarding, the server, the adapters), not internal helpers.
 */

// config — the frozen Tap contract + its validity types
export {
  parseConfig,
  type TapConfig,
  type ValidatedConfig,
  type Source,
  type FieldSpec,
  type ConfigError,
} from "./core/config";

// onboarding — deterministic (default) and LLM-refined (optional)
export { deriveConfig, deriveDecisions } from "./core/defaults";
export {
  onboard,
  type OnboardInput,
  type OnboardOptions,
  type OnboardResult,
  type OnboardEngine,
  type LlmProvider,
  type Decisions,
} from "./core/onboard";

// evals — the gate that turns a TapConfig into a servable ValidatedConfig
export { validate, runEvals, type EvalEngine, type EvalReport } from "./core/evals";

// query planning — the security perimeter (agents never send SQL)
export { planQuery, type QueryPlan, type AgentRequest } from "./core/query";

// errors-as-values
export { type Result, ok, err } from "./core/result";

// adapters — the external seams
export { DuckDbEngine } from "./adapters/source/duckdb";
export { claudeCli, codexCli, devLlm } from "./adapters/llm/cli";

// runtime — the hot path
export { createTapServer, type TapServerOptions } from "./runtime/server";
export {
  memoryCache,
  cacheKey,
  parseDurationMs,
  type RowCache,
} from "./runtime/cache";
