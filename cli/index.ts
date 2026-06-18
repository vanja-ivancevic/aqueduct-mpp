#!/usr/bin/env node
/**
 * `aqueduct` — the builder-facing CLI. Two commands:
 *
 *   aqueduct onboard <file> [flags]   profile a static file → write an eval-passed Tap config
 *   aqueduct serve   <config.json>    run the Tap (paid /query + free /schema) over MPP sessions
 *
 * Onboarding is the only place the LLM runs (invariant 1). `serve` is pure config execution +
 * payment. The config file written by `onboard` is the single source of truth for behavior.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { runMcpServer } from "../adapters/client/mcp";
import { akashCompute } from "../adapters/compute/akash";
import { localCompute } from "../adapters/compute/local";
import { DEFAULT_SPEC, type DeploySpec } from "../adapters/compute/provider";
import { devLlm } from "../adapters/llm/cli";
import { DuckDbEngine } from "../adapters/source/duckdb";
import { type FileFormat, type Source, inferFormat, parseConfig } from "../core/config";
import { PATH_USD } from "../core/constants";
import { deriveConfig } from "../core/defaults";
import { validate } from "../core/evals";
import { type OnboardInput, onboard } from "../core/onboard";
import { renderServiceEntry } from "../core/registry";
import { createTapServer } from "../runtime/server";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "onboard":
      return cmdOnboard(rest);
    case "serve":
      return cmdServe(rest);
    case "deploy":
      return cmdDeploy(rest);
    case "register":
      return cmdRegister(rest);
    case "mcp":
      return cmdMcp();
    case undefined:
    case "-h":
    case "--help":
      printHelp();
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      printHelp();
      return 1;
  }
}

// ── onboard ──────────────────────────────────────────────────────────────────
async function cmdOnboard(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const file = flags._[0];
  if (!file) {
    console.error(
      "usage: aqueduct onboard <file> [--name n] [--recipient 0x..] [--llm claude|codex] [--out config.json]",
    );
    return 1;
  }

  const format = flags.get("format") ? (flags.get("format") as FileFormat) : inferFormat(file);
  if (!format) {
    console.error(`cannot infer format from '${file}' — pass --format parquet|csv|json`);
    return 1;
  }
  const recipient = flags.get("recipient");
  if (!recipient) {
    console.error("missing --recipient <0x address> (where settlement is paid)");
    return 1;
  }

  const name = flags.get("name") ?? kebab(basename(file, extname(file)));
  const source: Source = {
    format,
    location: { via: isUrl(file) ? "url" : "path", ref: isUrl(file) ? file : resolve(file) },
    authEnv: flags.get("auth-env") ?? null,
    contract: { determinism: "deterministic", freshnessWindow: flags.get("freshness") ?? "24h" },
  };

  const input: OnboardInput = {
    name,
    source,
    recipient,
    currency: flags.get("currency") ?? PATH_USD,
  };
  const opts = { unitPrice: flags.get("unit-price") };
  const engine = await DuckDbEngine.create();

  // Deterministic by default (no LLM). `--refine` layers an LLM pass on top for smarter filters/evals.
  const refine = flags.get("refine") !== undefined;
  console.error(
    `▸ profiling ${source.location.ref} ${refine ? "(LLM refine)" : "(deterministic)"} …`,
  );
  const result = refine
    ? await onboard(
        input,
        { engine, llm: devLlm(flags.get("llm") === "codex" ? "codex" : "claude") },
        opts,
      )
    : await deriveConfig(input, { engine }, opts);
  if (!result.ok) {
    console.error(`✗ onboarding failed at ${result.error.stage}:`);
    for (const i of result.error.issues) console.error(`  - ${i}`);
    return 1;
  }

  engine.close(); // short-lived command — release the DuckDB connection

  const { config, schema, report, attempts } = result.value;
  const out = flags.get("out") ?? `${name}.tap.json`;
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);

  console.error(`✓ Tap '${config.name}' validated (${attempts} attempt${attempts > 1 ? "s" : ""})`);
  console.error(`  schema:   ${schema.map((f) => `${f.name}:${f.type}`).join(", ")}`);
  console.error(`  filters:  ${config.query.filters.map((f) => f.field).join(", ") || "(none)"}`);
  console.error(
    `  price:    ${config.pricing.unitPrice} / ${config.pricing.unit} (${config.pricing.unitDefinition})`,
  );
  console.error(
    `  evals:    ${report.results.filter((r) => r.passed).length}/${report.results.length} passed (score ${report.score.toFixed(2)})`,
  );
  console.error(`  written:  ${out}`);
  console.error(`\nnext: aqueduct serve ${out}`);
  return 0;
}

// ── serve ────────────────────────────────────────────────────────────────────
async function cmdServe(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const file = flags._[0];
  if (!file) {
    console.error("usage: aqueduct serve <config.json> [--port 8402]");
    return 1;
  }

  const pk = process.env.AQUEDUCT_PRIVATE_KEY;
  if (!pk) {
    console.error("set AQUEDUCT_PRIVATE_KEY to the server wallet key (receives settlement)");
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`cannot read config '${file}': ${msg}`);
    return 1;
  }

  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    console.error("config is invalid:");
    for (const i of parsed.error.issues) console.error(`  - ${i.path}: ${i.message}`);
    return 1;
  }

  // Re-run the eval gate before serving — never trust a config file blindly (invariant: only
  // eval-passed configs are servable).
  const engine = await DuckDbEngine.create();
  const gate = await validate(parsed.value, engine);
  if (!gate.ok) {
    console.error("config no longer passes evals — refusing to serve:");
    for (const r of gate.report.results.filter((x) => !x.passed))
      console.error(`  - ${r.name}: ${r.detail}`);
    return 1;
  }

  // Per-deployment MPP challenge secret — never the shared default. Set AQUEDUCT_SECRET to keep it
  // stable across restarts (needed if you run more than one instance behind a shared session store).
  const secretKey = process.env.AQUEDUCT_SECRET ?? randomBytes(32).toString("hex");
  const account = privateKeyToAccount(pk as `0x${string}`);
  // Optional distinct gas sponsor (a SEPARATE funded wallet) — enables fully-sponsored agent gas
  // including on-chain settle. Must differ from the settlement wallet (Tempo rejects sender==feePayer).
  const sponsorKey = process.env.AQUEDUCT_SPONSOR_KEY;
  const sponsorAccount = sponsorKey ? privateKeyToAccount(sponsorKey as `0x${string}`) : undefined;
  const app = createTapServer(gate.config, engine, {
    account,
    sponsorAccount,
    rpcUrl: process.env.AQUEDUCT_RPC_URL,
    realm: gate.config.name,
    secretKey,
  });

  const port = Number(flags.get("port") ?? process.env.PORT ?? 8402);
  serve({ fetch: app.fetch, port });
  console.error(`▸ Tap '${gate.config.name}' live on :${port}`);
  console.error("  GET  /schema             (free)   discovery + terms");
  console.error(
    `  GET  /query?q=<base64url> (paid)   ${gate.config.pricing.unitPrice}/${gate.config.pricing.unit} over MPP sessions`,
  );
  console.error("  POST /query              (paid)   MPP session channel lifecycle");
  console.error(`  wallet ${account.address} receives settlement`);
  await new Promise<never>(() => {}); // run until killed; never resolve so main() doesn't exit
  return 0; // unreachable
}

// ── deploy: render a deployment manifest for a compute target ─────────────────
async function cmdDeploy(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const target = flags.get("target");
  const provider =
    target === "akash" ? akashCompute : target === "local" ? localCompute : undefined;
  const image = flags.get("image");
  if (!provider || !image) {
    console.error(
      "usage: aqueduct deploy --target local|akash --image <ref> [--port 8402] [--dataset examples/exoplanets.csv] [--out file]",
    );
    return 1;
  }
  const spec: DeploySpec = {
    ...DEFAULT_SPEC,
    image,
    port: Number(flags.get("port") ?? DEFAULT_SPEC.port),
    dataset: flags.get("dataset") ?? DEFAULT_SPEC.dataset,
  };
  const artifact = provider.render(spec);
  const out = flags.get("out") ?? artifact.filename;
  writeFileSync(out, artifact.content);
  console.error(`✓ wrote ${out}  (${provider.target} target, image ${image})`);
  console.error("\nnext:");
  for (const note of artifact.notes) console.error(`  • ${note}`);
  return 0;
}

// ── register: render the MPP registry entry for a deployed Tap ────────────────
async function cmdRegister(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const file = flags._[0];
  const url = flags.get("url");
  if (!file || !url) {
    console.error(
      "usage: aqueduct register <config.json> --url https://<tap-host> [--description d] [--provider-name n] [--provider-url u]",
    );
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (e) {
    console.error(`cannot read config '${file}': ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    console.error("config is invalid:");
    for (const i of parsed.error.issues) console.error(`  - ${i.path}: ${i.message}`);
    return 1;
  }

  const providerName = flags.get("provider-name");
  const providerUrl = flags.get("provider-url");
  const entry = renderServiceEntry(parsed.value, {
    url,
    description: flags.get("description"),
    provider: providerName || providerUrl ? { name: providerName, url: providerUrl } : undefined,
  });

  // The entry goes to stdout (pipe it / paste into a PR); guidance goes to stderr.
  console.log(JSON.stringify(entry, null, 2));
  console.error(
    "\nAqueduct hosts no directory — discovery rides on MPP's registry. To publish this Tap:",
  );
  console.error(
    "  • add this entry to `schemas/services.ts` in github.com/tempoxyz/mpp (a PR; curated)",
  );
  console.error(
    "  • until merged, agents reach it directly by URL — /schema is free + self-describing",
  );
  return 0;
}

// ── mcp: serve the consumption client (discover/schema/query) over MCP stdio ───
async function cmdMcp(): Promise<number> {
  runMcpServer();
  await new Promise<never>(() => {}); // run until stdin closes / process is killed
  return 0; // unreachable
}

// ── tiny arg parser (no dep) ─────────────────────────────────────────────────
type Flags = { _: string[]; get(key: string): string | undefined };
function parseFlags(args: string[]): Flags {
  const positionals: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        named.set(key, "true");
      } else {
        named.set(key, next);
        i++;
      }
    } else if (a !== undefined) {
      positionals.push(a);
    }
  }
  return { _: positionals, get: (k) => named.get(k) };
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "") || "tap";

function printHelp() {
  console.error(`aqueduct — compile a static file into a metered, agent-payable Tap (MPP over Tempo)

commands:
  onboard <file>      profile a parquet/csv/json file → eval-passed Tap config
  serve   <config>    run the Tap: free /schema, paid /query over MPP sessions
  deploy              render a deployment manifest (local docker-compose or Akash SDL)
  register <config>   render the MPP registry entry to publish a deployed Tap (--url)
  mcp                 serve the consumption client (discover/schema/query) over MCP stdio

onboard flags:
  --name <n>          Tap name (default: derived from filename)
  --recipient <0x>    settlement payout address (required)
  --currency <0x>     settlement token (default: testnet pathUSD)
  --refine            layer an LLM pass over the deterministic config (smarter filters/evals)
  --llm claude|codex  dev inference provider for --refine (default: claude)
  --unit-price <dec>  price per row (default: 0.0001)
  --format <fmt>      override format inference (parquet|csv|json)
  --out <path>        config output path (default: <name>.tap.json)

serve flags:
  --port <n>          listen port (default: 8402)
  env AQUEDUCT_PRIVATE_KEY   server wallet key (required)
  env AQUEDUCT_RPC_URL       Tempo RPC (default: moderato testnet)`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
