import {
  DEFAULTS,
  Decisions,
  type OnboardEngine,
  type OnboardError,
  type OnboardInput,
  type OnboardOptions,
  type OnboardResult,
  assemble,
} from "./assemble";
/**
 * Onboarding — turn a static file into a `ValidatedConfig`, with the LLM doing ONLY data judgment.
 *
 * Division of labor (CLAUDE.md invariant 1: no LLM in the hot path; invariant 3: deterministic core,
 * explicit edges):
 *   - deterministic   : profile the file (DuckDB DESCRIBE → schema), assemble the config scaffold
 *                       (version/source/pricing/cache/heal/mpp), validate (parse + eval gate).
 *   - LLM (one call)  : author the *constrained query interface* + the priced-unit definition + a few
 *                       golden tripwires + invariants, given the inferred schema and a data sample.
 *
 * The LLM never sees a network socket and never writes SQL — it returns a small JSON `Decisions`
 * object that we merge into a fully-typed config and then run through the SAME eval gate the runtime
 * trusts. If evals fail, we feed the failure back and retry. The output is eval-passed or nothing.
 */
import { type FieldSpec, parseConfig } from "./config";
import { validate } from "./evals";
import { type Result, err, ok } from "./result";

// Re-export the neutral builder + its contracts so consumers can import everything onboarding-shaped
// from one place. The definitions live in `./assemble` so the deterministic path needn't touch this
// (LLM) module.
export {
  DEFAULTS,
  Decisions,
  type OnboardEngine,
  type OnboardError,
  type OnboardInput,
  type OnboardOptions,
  type OnboardResult,
  assemble,
} from "./assemble";

export type LlmError = { message: string };
/** A single-shot text model. Adapters: claude-cli / codex-cli (dev), openai / openrouter (prod). */
export interface LlmProvider {
  complete(req: { system: string; input: string }): Promise<Result<string, LlmError>>;
}

/**
 * Profile the file, ask the LLM for query+pricing+eval decisions, assemble a config, and gate it
 * through the eval engine. Retries with eval/parse feedback up to `maxAttempts`. Returns an
 * eval-passed `ValidatedConfig` or a located error — never an unvalidated config.
 */
export async function onboard(
  input: OnboardInput,
  deps: { engine: OnboardEngine; llm: LlmProvider },
  opts: OnboardOptions = {},
): Promise<Result<OnboardResult, OnboardError>> {
  const { engine, llm } = deps;
  const sampleSize = opts.sampleSize ?? DEFAULTS.sampleSize;
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;

  let schema: FieldSpec[];
  let sample: Record<string, unknown>[];
  try {
    schema = await engine.describe(input.source);
    sample = await engine.sampleRaw(input.source, sampleSize);
  } catch (e) {
    return err({ stage: "describe", issues: [errMsg(e)] });
  }
  if (schema.length === 0) {
    return err({ stage: "describe", issues: ["source has no columns"] });
  }

  const system = SYSTEM_PROMPT;
  let feedback = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userInput = buildInput(input, schema, sample, feedback);

    const raw = await llm.complete({ system, input: userInput });
    if (!raw.ok) {
      feedback = `Previous attempt errored: ${raw.error.message}. Return ONLY the JSON object.`;
      if (attempt === maxAttempts) return err({ stage: "llm", issues: [raw.error.message] });
      continue;
    }

    const json = extractJson(raw.value);
    const parsedDecisions = json === undefined ? undefined : Decisions.safeParse(json);
    if (!parsedDecisions?.success) {
      const issues = parsedDecisions
        ? parsedDecisions.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
        : ["response was not a JSON object"];
      feedback = `Your JSON was invalid: ${issues.join("; ")}. Fix and return ONLY the JSON object.`;
      if (attempt === maxAttempts) return err({ stage: "decisions", issues });
      continue;
    }

    const configObject = assemble(input, schema, parsedDecisions.data, opts);
    const parsed = parseConfig(configObject);
    if (!parsed.ok) {
      const issues = parsed.error.issues.map((i) => `${i.path}: ${i.message}`);
      feedback = `The assembled config was rejected: ${issues.join("; ")}. Keep query fields within the schema.`;
      if (attempt === maxAttempts) return err({ stage: "config", issues });
      continue;
    }

    const result = await validate(parsed.value, engine);
    if (result.ok) {
      return ok({ config: result.config, schema, report: result.report, attempts: attempt });
    }
    const failures = result.report.results
      .filter((r) => !r.passed)
      .map((r) => `${r.name}: ${r.detail}`);
    feedback = `Evals failed: ${failures.join("; ")}. Adjust query/golden/invariants so they pass.`;
    if (attempt === maxAttempts) return err({ stage: "evals", issues: failures });
  }

  // unreachable (loop returns on the final attempt), but keeps the type total
  return err({ stage: "evals", issues: ["exhausted attempts"] });
}

const SYSTEM_PROMPT = `You configure a paid, agent-facing data feed ("Tap") over a single static file.
You decide ONLY: the constrained query interface, the priced-unit definition, and a few eval tripwires.
You never write SQL, never invent columns, and never see the network.

Output ONLY a JSON object (no prose, no code fences) with this shape:
{
  "query": {
    "filters":     [{ "field": <schema field>, "ops": [<subset of eq,ne,lt,lte,gt,gte,in,like>] }],
    "selectable":  "*" | [<schema fields>],
    "sortable":    [<schema fields>],
    "maxLimit":    <int>, "defaultLimit": <int <= maxLimit>
  },
  "unitDefinition": <string: what one priced row means>,
  "golden":     [{ "request": <agent request>, "expectRowCount": <int> }],
  "invariants": [<SQL boolean over a row, e.g. "pop >= 0">]
}

Rules:
- Every field named in filters/selectable/sortable MUST be one of the declared schema fields.
- Only expose filters/sorts that make sense for the data's meaning and types.
- Choose like/in only where useful (like = text search; in = small categorical sets).
- Keep maxLimit reasonable (<= 1000). golden requests must use only the query interface you defined.`;

function buildInput(
  input: OnboardInput,
  schema: FieldSpec[],
  sample: Record<string, unknown>[],
  feedback: string,
): string {
  const schemaLines = schema
    .map((f) => `- ${f.name}: ${f.type}${f.required ? " (required)" : ""}`)
    .join("\n");
  const sampleJson = JSON.stringify(sample.slice(0, 10), null, 2);
  const parts = [
    `Tap name: ${input.name}`,
    `File format: ${input.source.format}`,
    `Determinism: ${input.source.contract.determinism}`,
    "",
    "Schema (inferred):",
    schemaLines,
    "",
    "Sample rows:",
    sampleJson,
  ];
  if (feedback) parts.push("", "IMPORTANT — fix this from your last attempt:", feedback);
  return parts.join("\n");
}

/** Pull the first JSON object out of a model response (tolerates code fences / surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text) ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
