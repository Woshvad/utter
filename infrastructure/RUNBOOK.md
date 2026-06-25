# Operator RUNBOOK - the three live Phase 3 acceptances

> These three acceptances need genuine operator-provisioned infrastructure that
> does not exist in the repo (a gVisor host + a `*.resources.<domain>` wildcard
> TLS/DNS + an internal mirror). They are **operator-gated** and recorded as
> **Deferred Items** in `.planning/STATE.md`, exactly as Phases 1 and 2 gated
> their live on-chain actions. They are **NOT autonomous phase blockers** - the
> phase passes on the green Plans 02-05 suite, which proves all the logic against
> the in-memory + `docker-dev` backends. Plain Docker / Docker Desktop is **NOT**
> a security boundary (CLAUDE.md, SPEC 9.5); these run ONLY on the runsc host.

## Provisioning order (do this first)

Provision per `infrastructure/sandbox-host/PROVISION.md`, in order:

1. the gVisor host - `runsc install` + daemon.json runtime + overlay2/xfs pquota,
2. the host egress firewall - `infrastructure/sandbox-host/nftables.rules.sh`,
3. the internal Verdaccio build mirror - `REGISTRY_MIRROR_URL`,
4. the `*.resources.<domain>` wildcard TLS / DNS-01 - `DNS_PROVIDER` / `DNS_API_TOKEN`.

Confirm the PROVISION.md checklist is fully green before running any acceptance.

---

## Acceptance 1 - live malicious-probe-blocked (SBX-02 / SBX-06)

**Goal:** a malicious endpoint cannot reach the metadata service, an RFC1918 host,
the Arc RPC, the facilitator, or the host from inside the gVisor container netns,
and publication is failed/flagged.

```bash
# 1. Build the blocked-host probe-tester image on the host (per the probe contract):
#    a tiny image that, given PROBE_TARGET, attempts a TCP connect + HTTP GET and
#    exits 0 ONLY if the host is reachable (the containment-FAILURE outcome).
docker build -t utter/blocked-host-probe:latest infrastructure/sandbox-host/probe/

# 2. Run the malicious fixture (services/sandbox/test/fixtures/malicious) under
#    runsc behind the host nftables rules, then drive the dynamic blocked-host
#    probe (createLiveHostProbe) against the full EGRESS_BLOCK_SET:
#      169.254.169.254 (metadata), an RFC1918 host, the Arc RPC, the facilitator,
#      and the host loopback.
node --experimental-strip-types - <<'TS'
import { GvisorRunner, buildRunSpec, createLiveHostProbe, DEFAULT_PROBE_TARGETS } from "@utter/sandbox";
const runner = new GvisorRunner();                 // runtime=runsc (trusted boundary)
const probe = createLiveHostProbe({ runner });     // throws unless backend==='gvisor'
const spec = buildRunSpec({ image: "utter/blocked-host-probe:latest", backend: "gvisor", maxTimeoutSeconds: 30, limits: { pidsLimit: 128, memoryBytes: 256 * 1024 * 1024, cpus: 0.5 } });
await probe.assertBlocked(spec, [...DEFAULT_PROBE_TARGETS]);  // rejects (ContainmentFailureError) if ANY is reachable
console.log("SBX-02/06 OK: every blocked host unreachable from the gVisor container netns");
TS
```

**Pass:** `assertBlocked` resolves (every target unreachable); the malicious
sample's publication is failed/flagged by the pre-publish gate. **Fail:** a
`ContainmentFailureError` lists any reachable host - the egress firewall is not
enforcing the block set; do not publish.

---

## Acceptance 2 - runsc-enforced resource limits + disk quota (SBX-04)

**Goal:** the hardened run-spec's memory / PID / disk caps + read-only root +
timeout hold under runsc on the provisioned host.

```bash
# Run the sample under the hardened run-spec (--runtime=runsc) and confirm each cap.
# memory: an allocation past --memory is OOM-killed.
docker run --rm --runtime=runsc --memory=256m --pids-limit=128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --storage-opt size=512m busybox sh -c '
    touch /should-fail 2>/dev/null && echo "FAIL: root is writable" || echo "OK: read-only root";
    dd if=/dev/zero of=/tmp/big bs=1M count=600 2>/dev/null && echo "check disk quota" || echo "OK: tmpfs bounded";
  '
# timeout: the runner (GvisorRunner) kills the container at timeoutSeconds =
# RESOURCE_TIMEOUT_SECONDS; confirm a sleep past the deadline is killed.
```

**Pass:** read-only root rejects writes; the tmpfs + `--storage-opt size=` bound
disk; memory/PID caps hold; the timeout kills an over-running container. **Fail:**
any cap is not enforced - re-check the storage driver (overlay2 + xfs pquota) and
the runsc runtime registration in PROVISION.md.

---

## Acceptance 3 - live HTTPS 402->200 paywalled deploy (DEP-01 / DEP-02)

**Goal (Phase 1, trusted echo + in-process gate):** the deploy orchestrator BUILDS
the echo image, RUNS it as a hardened runsc service named `utter_res_echo` on the
`utter_appnet` network, WRITES the Traefik route to disk, ENSURES the buyer's escrow
deposit, and proves the echo is reachable over real wildcard TLS at
`https://<slug>.resources.<domain>` returning **402 unpaid** then **200 after a paid
call**, with a real on-chain `Debited` event (70/30 split) on Arc Testnet.

> The PRX-02 blocked-host egress probe is **Phase-2-gated**: it runs only when
> `UTTER_RUN_EGRESS_PROBE=1` (the probe image is built + the host nftables rules land
> with the Phase 2 increment). In Phase 1 it SKIPS with a clear log, recorded as a
> skip - not a pass and not a blocker for the live 402->200 proof.

The EXACT operator host sequence:

```bash
# 1. Pull the latest code + install.
cd /opt/utter && git pull && pnpm install

# 2. Pin the node base image BY DIGEST (the build asserts pinned-by-digest, so a
#    floating tag fails loud). Pull, read the digest, and set it in .env.local:
docker pull node:22-bookworm-slim
docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim
#   -> set DEPLOY_BASE_IMAGE_NODE=node:22-bookworm-slim@sha256:<digest> in .env.local

# 3. Confirm .env.local (gitignored - never commit a real key) has:
#      DEPLOY_DOMAIN              = utter.technology     (apex is resources.<domain>)
#      RELAYER_SIGNER_KEYS        = the relayer/escrow-admin key(s)
#      TEST_BUYER_PRIVATE_KEY     = the funded buyer EOA key
#      REGISTRY_ADMIN_PRIVATE_KEY = the registry Ownable owner key
#      PLATFORM_TREASURY          = the platform split recipient address
#      DEPLOY_BASE_IMAGE_NODE     = the digest-pinned base from step 2
#      ARC_RPC_URL                = https://rpc.testnet.arc.network  (optional; default)
#    NO manual FACILITATOR_URL is needed: live-deploy auto-resolves the facilitator's
#    on-network IP (see step 4 note). Set FACILITATOR_URL only to override the default
#    for a non-default deploy.
#    .env.local is loaded from the REPO ROOT regardless of cwd, so you can run the
#    deploy from the repo root OR from services/deployer (step 5) - both forms work.
#    Fund the buyer + relayer with testnet USDC at https://faucet.circle.com - the
#    deposit + settle spend REAL testnet USDC.

# 4. Bring up the platform stack (traefik, redis, data-proxy, facilitator) on appnet.
#    IMPORTANT: when compose networks change - or on the FIRST bring-up after a pull
#    that adds a service to utter_appnet - recreate the FULL stack (NO single-service
#    filter), or Traefik stays off utter_appnet and every paid/unpaid call 502s:
docker compose --env-file .env.local -f infrastructure/docker-compose.yml up -d --build
#    Verify Traefik actually joined the app network (it MUST be listed):
docker network inspect utter_appnet --format '{{range .Containers}}{{.Name}} {{end}}'
#    A 502 (NOT a TLS error) at the paid/unpaid call means Traefik cannot reach the
#    backend - it is not on utter_appnet. Recreate the full stack (line above), do
#    NOT bring up a single service with a filter.
#
#    Why no manual FACILITATOR_URL: a deployed resource runs under runsc/gVisor, which
#    cannot use Docker's embedded DNS at 127.0.0.11, so the name `facilitator` would
#    EAI_AGAIN inside the resource container. live-deploy inspects utter_appnet and
#    hands the resource the facilitator's literal IP:port. (Durable production fix: a
#    static IP / ExtraHosts mapping; the inspect is the no-manual-step bring-up fix.)

# 5. Run the deploy WITH the host gate. UTTER_SANDBOX_HOST=1 is REQUIRED: it tells
#    resolveDockerHandle to construct a real dockerode so the orchestrator can build +
#    run the container (off-host it refuses, no dead-URL curl). Run from the repo root
#    OR from services/deployer - .env.local loads from the repo root either way:
cd services/deployer && UTTER_SANDBOX_HOST=1 node --import ../../scripts/ts-resolver.mjs \
  --experimental-strip-types src/live-deploy.ts
```

`liveDeployEcho` (`services/deployer/src/live-deploy.ts`) then:

- auto-resolves the facilitator's on-network IP and hands it to the resource (no
  manual FACILITATOR_URL; an explicit env override still wins),
- registers the resource on-chain (or logs "already active" on a redeploy),
- ensures `balanceOf(buyer) >= cap` on `PaymentEscrow`: a guarded ERC-20 `approve`
  (only when allowance is short - `deposit()` pulls via `safeTransferFrom`) then a
  `deposit(need)`,
- BUILDS the echo image, RUNS `utter_res_echo` under runsc on `utter_appnet`,
- WRITES `infrastructure/traefik/dynamic/<slug>.yml` atomically (the file provider
  hot-loads it; the loadBalancer targets `http://utter_res_echo:8080`),
- polls `https://<slug>.resources.<domain>/echo` with **no X-PAYMENT** until **402**
  (tolerating container boot + first-time ACME wildcard-cert issuance latency),
- signs a real `DebitAuthorization` and re-calls with `X-PAYMENT` -> asserts **200** +
  the `X-PAYMENT-RESPONSE` receipt over HTTPS,
- decodes the receipt, reads the settle tx on-chain, and ASSERTS the `Debited` event
  (debit <= cap; the creator/treasury split matches the configured `PLATFORM_FEE_BPS`
  ratio), then PRINTS the settle tx + its ArcScan link (a self-verifying on-chain
  proof; a failed assertion fails the deploy).

**Expected:** the registration tx (or "already active"), the resolved facilitator
IP:port, the echo image built, the container running under runsc on `utter_appnet`,
the Traefik file written, 402 then 200 + the receipt, and the PRINTED settle tx +
ArcScan link. The run itself asserts the `Debited` event (debit <= cap and the
configured split); open `https://testnet.arcscan.app/tx/<tx>` to confirm visually.

**Fail:** any assertion throws - the build, the run, the route, the deposit, the live
paywall, or the wildcard cert is not holding in production.

Security notes hold throughout: the deploy is operator-gated (`UTTER_SANDBOX_HOST=1`),
keys are read only from `.env.local` and are NEVER logged (the script logs only
amounts, image tags, container names, and the written path).

---

## After running

Once all three acceptances pass on the provisioned host, update the three
**Deferred Items** rows in `.planning/STATE.md` from "Deferred (operator-gated)"
to "Verified live", and tick the `## Manual-Only Verifications` rows in
`.planning/phases/03-sandbox-deploy/03-VALIDATION.md`. Until then they remain
Deferred Items - the autonomous logic is already proven by the Plans 02-05 suite.
