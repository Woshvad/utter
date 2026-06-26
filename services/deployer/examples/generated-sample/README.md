# generated-sample - a sample untrusted generated bundle

This directory is a sample untrusted generated bundle for the operator host runbook. It
is a committed, gate-clean stand-in for a studio-generated bundle so an operator can point
`DEPLOY_BUNDLE_PATH` at a real, deployable bundle when walking the generated-bundle deploy
section of `infrastructure/RUNBOOK.md`.

## What is untrusted, and what the deploy path reads

`handler.ts` is the UNTRUSTED code. The pre-build static gate
(`services/deployer/src/gate-bundle.ts`) scans it before any build runs, and a malicious
handler is rejected before any artifact is produced. This sample handler is kept benign on
purpose: it imports only the Hono `Context` type, touches no env, opens no socket, and
imports nothing on the deny-list, so it passes the gate.

Only two files are read by the deploy path:

- `handler.ts` is the code bundled into the trusted gate-less shim's `server.js` (the
  esbuild path in `services/deployer/src/bundle-generated.ts`). It runs behind the trusted
  sidecar, holds no facilitator token, and never reaches the money path itself.
- `openapi.json` is the classifier schema the trusted sidecar compiles, so declared errors
  (bad buyer input) are classified and stay free through the gate.

`agent-card.json` and `test-cases.json` are declarative aids, not inputs the deploy path
reads. The gate scans `handler.ts`, not these files.

## Where slug, resourceId, and pricing come from

This bundle NEVER sets the slug, the on-chain resourceId, or the pricing. Those are
operator inputs from ENV (`DEPLOY_SLUG`, optional `DEPLOY_RESOURCE_LABEL`, and the
`PRICE_*` / `MAX_RESPONSE_BYTES` terms) and from the studio. The bundle contributes only
its `openapi.json` classifier schema.

## Deploying it

See the "Generated (untrusted) bundle deploy - DEPLOY_BUNDLE_PATH + studio end to end"
section in `infrastructure/RUNBOOK.md` for the standalone CLI deploy, the adversarial gate
proof, and the studio end-to-end walk.
