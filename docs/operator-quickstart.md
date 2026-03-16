# Operator Quickstart

This repo is a reference implementation of an evidence capture operator, not the trust anchor itself. Operators should preserve artifacts, publish checkpoints, and distribute public keys so verifiers can check proof packages offline.

## Minimal setup

1. Configure `DATABASE_URL`.
2. Optionally configure operator keys with `OPERATOR_PRIVATE_KEY_PEM` / `OPERATOR_PRIVATE_KEY_PATH` and matching public key env vars.
3. Run `npm run db:migrate`.
4. Start the API with `npm run dev:api` and the worker with `npm run dev:worker` if embedded worker mode is disabled.

## Publish verification material

Export the current operator public key:

```bash
npm run transparency:operator-key -- operator-public-key.json
```

Export the latest checkpoint:

```bash
npm run transparency:checkpoint -- checkpoint.json
```

## Verify a package offline

```bash
npm run proof:verify -- <package-directory> --checkpoint checkpoint.json --operator-key operator-public-key.json
```

## Watchlists

Watchlists run inside the worker and are intended to stay self-hostable:
- Postgres stores watchlists, runs, and notification deliveries
- the worker claims due watchlists and queues ordinary captures
- webhook delivery is best-effort and never mutates evidence facts

## Trust reminder

What should survive any one operator is the proof package format, the verifier, the checkpoint format, and the public operator key distribution path.
