# Deploy a Tap (local ↔ Akash)

A Tap ships as **one stateless container**. At boot it onboards a baked dataset deterministically
(no LLM — invariant 1), runs the eval gate, then serves `/schema` (free) and `/query` (paid, MPP
sessions over Tempo). The *same image* runs on your laptop and on [Akash](https://akash.network);
the only thing that changes is the orchestrator manifest. `aqueduct deploy` renders that manifest.

```
profile file ──onboard(deterministic)──► Tap config ──serve──► /schema + /query
        (all of this happens inside the container, at boot, from env vars)
```

## What the container needs (env)

| Var | Required | Meaning |
|-----|----------|---------|
| `AQUEDUCT_PRIVATE_KEY` | yes | server wallet key — receives settlement |
| `AQUEDUCT_RECIPIENT`   | yes | payout address (usually the server wallet's own address) |
| `AQUEDUCT_SECRET`      | yes | MPP challenge-signing secret — `openssl rand -hex 32`. Stable across restarts |
| `AQUEDUCT_DATASET`     | no  | dataset path baked in the image (default `examples/exoplanets.csv`) |
| `AQUEDUCT_SPONSOR_KEY` | no  | a **separate** funded wallet to sponsor agents' gas. Must differ from the settlement wallet |
| `AQUEDUCT_RPC_URL`     | no  | Tempo RPC (default: Moderato testnet) |
| `PORT`                 | no  | listen port (default `8402`) |

Secrets are **never baked** into the image. Local injects them via `${VAR}` interpolation from your
shell/`.env`; Akash takes them as manifest values you fill in. The image is the same either way.

## Build the image

```bash
docker build -t ghcr.io/<you>/aqueduct:1.0.0 .
```

Multi-stage: build with `tsup`, then a slim runtime that rebuilds the DuckDB native binding and
copies `dist/` + `examples/`. To serve a bigger dataset, drop it in `examples/` (or any COPY'd path)
and set `AQUEDUCT_DATASET` — the snapshot ships *in the image*, so there's no runtime download and no
persistent volume to manage (Akash storage is lease-scoped anyway).

## Local (docker-compose)

```bash
aqueduct deploy --target local --image ghcr.io/<you>/aqueduct:1.0.0
# → writes docker-compose.yml

export AQUEDUCT_PRIVATE_KEY=0x…   AQUEDUCT_RECIPIENT=0x…   AQUEDUCT_SECRET=$(openssl rand -hex 32)
docker compose up
curl localhost:8402/schema          # free discovery + terms
```

The compose file references secrets as `${AQUEDUCT_PRIVATE_KEY:?…}` — compose fails loudly if one is
unset, never substitutes a blank.

## Akash (production)

```bash
aqueduct deploy --target akash --image ghcr.io/<you>/aqueduct:1.0.0
# → writes akash.deploy.yaml
```

1. **Push the image** somewhere Akash providers can pull: `docker push ghcr.io/<you>/aqueduct:1.0.0`
   (must be public/pullable).
2. **Fill the secrets** in `akash.deploy.yaml` — replace each `CHANGE_ME`
   (`AQUEDUCT_PRIVATE_KEY` / `AQUEDUCT_RECIPIENT` / `AQUEDUCT_SECRET`).
3. **Deploy** via [Akash Console](https://console.akash.network) (upload the YAML) or the CLI:
   ```bash
   akash tx deployment create akash.deploy.yaml --from <key>
   akash tx market lease create …          # accept a bid
   akash provider send-manifest akash.deploy.yaml …
   ```
4. **Get the URL**: `akash provider lease-status …` → the `global: true` host → `GET <host>/schema`.

### Long-running query connections

Akash's HTTP ingress (NGINX) drops idle connections at a **60s default**, which would cut a slow
cache-miss query whose upstream is still responding. The rendered SDL raises
`read_timeout`/`send_timeout` to 1h and sets `next_cases: ["off"]` so a long query survives. If a
provider's ingress still stalls connections, expose a **non-80/443 port** in the SDL to get a raw
NodePort and skip ingress entirely.

## Why stateless

Deterministic onboard-at-boot means the container has no state to lose: kill it, migrate it, scale
`count`, and every replica derives the *identical* Tap config from the same baked dataset + env. No
persistent volume, no config drift, no "which instance has the good config" problem. This is what
makes the local image and the Akash image literally the same artifact.
