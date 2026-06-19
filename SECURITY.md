# Security Policy

Aqueduct handles wallet keys and on-chain settlement, so security reports are taken seriously.

**Report a vulnerability privately** — do not open a public issue. Email **vanja.ivancevic@gmail.com**
with a description, reproduction steps, and impact. Expect an acknowledgement within a few days.

## Scope notes

- Aqueduct is **non-custodial**: it never holds user funds. Settlement is peer-to-peer agent↔operator
  on Tempo. A private key (`AQUEDUCT_PRIVATE_KEY`, `AQUEDUCT_AGENT_KEY`) stays on the machine that owns
  it and is read from the environment — never commit one.
- This is hackathon-stage software running on the Tempo **Moderato testnet**. Do not point it at
  mainnet funds.
- Agents never send SQL: requests are constrained to declared filters/columns and compiled to
  parameterized DuckDB queries (`core/query.ts`). Report any path that bypasses this perimeter.
