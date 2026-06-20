# Deploy a Tap (local container)

A Tap ships as **one stateless container**. At boot it onboards a baked dataset deterministically
(no LLM — invariant 1), runs the eval gate, then serves `/schema` (free) and `/query` (paid, MPP
sessions over Tempo). `aqueduct deploy` renders the docker-compose manifest.

```
profile file ──onboard(deterministic)──► Tap config ──serve──► /schema + /query
        (all of this happens inside the container, at boot, from env vars)
```

## What the container needs (env)

| Var | Required | Meaning |
|-----|----------|---------|
| `AQUEDUCT_PRIVATE_KEY` | yes | server wallet key — receives settlement |
| `AQUEDUCT_RECIPIENT`   | yes | payout address (must be the server wallet's own address — it's the MPP channel payee) |
| `AQUEDUCT_SECRET`      | no¹ | MPP challenge-signing secret — `openssl rand -hex 32`. Random per process if unset; ¹set it to keep it stable across restarts (required for a multi-replica deploy behind a shared session store) |
| `AQUEDUCT_DATASET`     | no  | dataset path baked in the image (default `examples/doaj-journals.csv`) |
| `AQUEDUCT_SPONSOR_KEY` | no  | a **separate** funded wallet to sponsor agents' gas. Must differ from the settlement wallet |
| `AQUEDUCT_RPC_URL`     | no  | Tempo RPC (default: Moderato testnet) |
| `PORT`                 | no  | listen port (default `8402`) |

Secrets are **never baked** into the image — compose injects them via `${VAR}` interpolation from your
shell / `.env`.

## Build the image

```bash
docker build -t ghcr.io/<you>/aqueduct:1.0.0 .
```

Multi-stage: build with `tsup`, then a slim runtime that rebuilds the DuckDB native binding and
copies `dist/` + `examples/`. To serve a bigger dataset, drop it in `examples/` (or any COPY'd path)
and set `AQUEDUCT_DATASET` — the snapshot ships *in the image*, so there's no runtime download and no
persistent volume to manage.

## Run it (docker-compose)

```bash
aqueduct deploy --target local --image ghcr.io/<you>/aqueduct:1.0.0
# → writes docker-compose.yml

export AQUEDUCT_PRIVATE_KEY=0x…   AQUEDUCT_RECIPIENT=0x…   AQUEDUCT_SECRET=$(openssl rand -hex 32)
docker compose up
curl localhost:8402/schema          # free discovery + terms
```

The compose file references secrets as `${AQUEDUCT_PRIVATE_KEY:?…}` — compose fails loudly if one is
unset, never substitutes a blank.

## Why stateless

Deterministic onboard-at-boot means the container has no state to lose: kill it, migrate it, scale
`count`, and every replica derives the *identical* Tap config from the same baked dataset + env. No
persistent volume, no config drift, no "which instance has the good config" problem.

## Future: permissionless hosting

Because the image is self-contained and stateless, running it on a permissionless host like
[Akash](https://akash.network) is a natural next step — **not yet tested**. The main thing to verify
there is the provider's HTTP ingress: NGINX-style ingress often drops idle connections at ~60s, which
would cut a slow cache-miss query, so a long-query timeout (or a raw non-80/443 port) would be needed.
