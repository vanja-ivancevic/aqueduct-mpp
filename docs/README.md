# Aqueduct documentation

Reference docs for building, serving, and consuming a **Tap** — a metered, agent-payable data feed
compiled from a static parquet / CSV / JSON file.

Start at the project [README](../README.md) for the 30-second tour. These pages are the precise
reference behind it.

| Page | What it covers |
|------|----------------|
| [http-api.md](./http-api.md) | The Tap's HTTP surface: `/schema`, `GET`/`POST /query`, status codes, the receipt |
| [config.md](./config.md) | The Tap config — the frozen source of truth for a Tap's behavior, field by field |
| [query.md](./query.md) | The agent request shape and the constrained query interface (why agents never send SQL) |
| [pricing.md](./pricing.md) | How a request is priced and billed over an MPP session |
| [../DEPLOY.md](../DEPLOY.md) | Ship a Tap as a container — local docker-compose ↔ Akash |
| [../DEMO.md](../DEMO.md) | The live LLM-buys-data demo on NASA's exoplanet archive |

**Design docs** (the *why*, for contributors) live in [`../knowledge/`](../knowledge/00-index.md):
architecture (`08`), correctness & evals (`10`), Tempo testnet setup (`09`).

## The model in one paragraph

You point Aqueduct at a file. **Onboarding** (the only place an LLM may run) profiles it and writes a
frozen **[Tap config](./config.md)** — schema, a constrained query interface, pricing, evals. **Serving**
is pure, deterministic execution of that config behind an MPP payment: an agent reads
[`/schema`](./http-api.md#get-schema) for free, sends a [constrained query](./query.md) to
[`/query`](./http-api.md#get-query), pays [`rows × unitPrice`](./pricing.md) over an off-chain session
voucher, and gets rows + a receipt. No LLM, no schema inference, no raw SQL ever touches the paid path.
