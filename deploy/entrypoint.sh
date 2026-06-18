#!/bin/sh
# Container boot: deterministically onboard the baked dataset (no LLM), then serve the Tap.
# Identical behavior locally and on Akash — the only inputs are env vars.
set -e

: "${AQUEDUCT_DATASET:=examples/exoplanets.csv}"
: "${AQUEDUCT_RECIPIENT:?set AQUEDUCT_RECIPIENT (payout address)}"
: "${AQUEDUCT_PRIVATE_KEY:?set AQUEDUCT_PRIVATE_KEY (server wallet)}"

echo "▸ onboarding ${AQUEDUCT_DATASET} (deterministic) …"
node dist/cli.js onboard "${AQUEDUCT_DATASET}" --recipient "${AQUEDUCT_RECIPIENT}" --out /tmp/tap.json

exec node dist/cli.js serve /tmp/tap.json
