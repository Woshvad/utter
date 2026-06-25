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

## Untrusted (Phase 2) deploy - the sidecar/handler pair

**Goal (Phase 2, arbitrary AI-generated code):** the SAME live 402 -> 200 proof,
but now served through the trusted sidecar gate in front of an untrusted gate-less
handler, on the six-network topology, with the handler's direct facilitator / Arc
RPC route simultaneously DROPPED. This is the C1/C2 containment: the handler holds
no facilitator route + no caller-auth token (it joins `proxynet` only); the
sidecar (only) reaches the facilitator (on `controlplane`) and reverse-proxies
validated calls to the handler (on `proxynet`). Traefik routes to the SIDECAR.

> Prerequisite: Acceptances 1-3 above pass on the provisioned host (gVisor,
> wildcard TLS, the host nftables `policy drop`). This section adds the six-net
> topology + the sidecar pair + the live egress probe (PRX-02) on top of them.

The EXACT operator host sequence:

```bash
# 1. Pull the latest code + install, then set the untrusted-arming env in .env.local
#    (gitignored - NEVER commit a real key). Beyond the existing Phase-1 keys
#    (RELAYER_SIGNER_KEYS / DEPLOY_DOMAIN / REGISTRY_ADMIN_PRIVATE_KEY /
#    PLATFORM_TREASURY / TEST_BUYER_PRIVATE_KEY / DEPLOY_BASE_IMAGE_NODE / DNS-01
#    creds), set:
cd /opt/utter && git pull && pnpm install
#      FACILITATOR_AUTH_SECRET = a fresh random secret, >=32 chars (generate one,
#                                e.g. `openssl rand -hex 32`). NEVER commit it.
#      NODE_ENV                = production   (arms the facilitator caller-auth, B9)
#    Ordering hazard: do NOT set NODE_ENV=production before the sidecar exists - it
#    would 401 every call. With the Phase 2 sidecar landed, the sidecar mints +
#    presents the per-resource token, so production + the minted token are correct
#    together. Set both only for this untrusted pair deploy.

# 2. Full-stack recreate onto the SIX networks (NO single-service filter, or
#    Traefik / the facilitator end up on the wrong nets and every call 502s):
docker compose --env-file .env.local -f infrastructure/docker-compose.yml up -d --build
#    Verify the six nets exist and the memberships are right:
docker network ls   # expect: edge ingress controlplane proxynet upstreamnet redisnet
docker network inspect proxynet \
  --format '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}'
#    -> the data-proxy MUST be present at 172.30.0.10 (the static nftables target).
docker network inspect controlplane \
  --format '{{range .Containers}}{{.Name}} {{end}}'   # facilitator present; NO redis
docker network inspect redisnet \
  --format '{{range .Containers}}{{.Name}} {{end}}'   # redis + data-proxy ONLY
#    Confirm redis is on NEITHER proxynet NOR controlplane (M6); it is on redisnet
#    only and is unpublished (no host 6379).

# 3. Apply the host nftables default-deny egress. DATA_PROXY_IP is the static
#    proxynet address; DATA_PROXY_PORT is the data-proxy listen port (8080);
#    FACILITATOR_IP resolves on controlplane (inspect it above). The ruleset shape
#    is unchanged from Phase 1 - this is the C2 resolution, now honest because the
#    handler is off controlplane and never needs the facilitator:
DATA_PROXY_IP=172.30.0.10 DATA_PROXY_PORT=8080 \
  ARC_RPC_IP=<resolved-arc-rpc-ip> \
  FACILITATOR_IP=<facilitator-ip-on-controlplane> \
  UTTER_SANDBOX_HOST=1 sudo -E bash infrastructure/sandbox-host/nftables.rules.sh

# 4. Run the pair deploy WITH the live egress probe. UTTER_SANDBOX_HOST=1 lets the
#    orchestrator build + run the containers; UTTER_RUN_EGRESS_PROBE=1 arms PRX-02
#    (skipped in Phase 1). Run from the repo root (.env.local loads from there):
UTTER_SANDBOX_HOST=1 UTTER_RUN_EGRESS_PROBE=1 node \
  --import ./scripts/ts-resolver.mjs --experimental-strip-types \
  services/deployer/src/live-deploy.ts
```

The pair deploy then: mints the facilitator caller-auth token, launches the
HANDLER (on `proxynet` only) + the SIDECAR (on `ingress`+`controlplane`+`proxynet`),
inspects the handler IP for the sidecar (runsc cannot use Docker DNS), registers +
deposits, proves **402 -> 200 THROUGH the sidecar** with the on-chain `Debited`
split, AND asserts **PRX-02**: from inside the handler container netns, the
metadata IP, an RFC1918 host, the Arc RPC, the facilitator, and host loopback are
all UNREACHABLE.

**Acceptance (the Phase 2 proof):** 402 -> 200 served through Traefik -> sidecar ->
handler WHILE the handler's direct facilitator / Arc RPC route is simultaneously
dropped (the C1/C2 containment). **Fail:** a `ContainmentFailureError` lists any
reachable host (the topology or nftables is not enforcing the deny), or the
402 -> 200 / on-chain assertion throws.

---

## Phase 2 known limitations - NOT yet safe for untrusted MULTI-TENANT

The sidecar/handler pair above contains the untrusted handler well enough for a
SINGLE-TENANT deploy of the trusted echo: the handler holds no facilitator route and
no caller-auth token, the escrow gate runs only in the sidecar, runsc + the host
nftables + the per-container cgroup caps all hold, and the live egress probe (PRX-02)
confirms the handler cannot reach the facilitator, the Arc RPC, the metadata IP, an
RFC1918 host, or host loopback. Two gaps remain. Read both before arming an UNTRUSTED
multi-tenant host. The first is the blocker; do not run adversary-controlled
multi-tenant code until it lands.

### 1. Flat shared proxynet (cross-tenant free compute) - HIGH

Every resource's gate-less HANDLER joins the single shared `proxynet`, and Docker
inter-container communication (ICC) is on for that bridge. So an adversary's handler
can reach a SIBLING tenant's gate-less handler at L3 and POST its `/call` directly -
with NO escrow reservation. The sibling handler has NO auth on `/call` (the whole
point of the C1 split is that the gate lives only in the sidecar), so this is
free compute charged against another creator's resource, not merely lateral probing.
An adversary handler can also laterally probe sibling sidecars on the same bridge.

Why it is currently UNCAUGHT: the host nftables ruleset filters at the host OUTPUT
hook, which does not see intra-bridge (handler-to-handler) traffic; and the PRX-02
probe asserts only that off-bridge targets (facilitator, Arc RPC, metadata, RFC1918,
loopback) are unreachable - it does not test a sibling peer ON proxynet, so a reachable
sibling passes today.

SAFE for: single-tenant + the trusted echo. There is no sibling to victimize, and the
handler code is ours and audited. NOT safe for: untrusted multi-tenant.

FIX PATH (the per-resource network segmentation deferred in
`RESOURCE-DEPLOY-DESIGN.md` open-decision 4 / D6, now sharpened from "lateral probing"
to "cross-tenant free compute"):

- Give each pair a DEDICATED internal handler-to-sidecar network, `pairnet_<slug>`, so
  no sibling can address another tenant's handler. The sidecar reaches its own handler
  on the pair net by inspected IP (as today).
- Move the SIDECAR OFF the shared `proxynet`. The sidecar only needs `ingress`
  (Traefik in), `controlplane` (the facilitator), and its own `pairnet_<slug>` (the
  handler). It does not need the shared `proxynet`.
- Keep the HANDLER on `proxynet` ONLY for its data-plane egress to the data-proxy at
  the static `172.30.0.10`, plus its own `pairnet_<slug>` for the sidecar hop.
- Add a host DOCKER-USER / FORWARD-path nftables rule scoped to `proxynet` that ACCEPTs
  handler-to-data-proxy (`172.30.0.10`) and DROPs all other intra-`proxynet` traffic,
  so even on the shared egress bridge a handler cannot reach a sibling.
- Add a PRX-02 probe TARGET asserting a sibling handler/sidecar IP on `proxynet` is
  UNREACHABLE, so the acceptance actually covers this gap (today it does not).

This is a tracked follow-up. Do NOT enable untrusted multi-tenant until it lands.

### 2. H4 lifecycle loop not auto-started in the live path - LOW (Phase 3)

`createReconcileLoop`, the runaway reaper, the host concurrency cap, and
`listResourceContainers` / `reapResourceContainer` are implemented and exported, but
NO host bootstrap starts them - `services/deployer/src/server.ts` deliberately starts
no loop. So on the live host today, orphan-reap (T-03-19), runaway quarantine, and the
global host concurrency cap do NOT run against live pairs.

This is NOT a containment escape: the network topology, the host nftables, the
per-container cgroup caps (pids/mem/cpu), and the escrow gate all still hold. The
lifecycle defenses are simply inert until the Phase 3 wiring lands - a small deployer
daemon that constructs the loop with the pair-aware adapters. Note
`listResourceContainers` returns BOTH the handler and the sidecar under the same
`io.utter.resource-id` label, so that wiring MUST be pair-aware (reaping one role must
account for its sibling).

---

## After running

Once all three acceptances pass on the provisioned host, update the three
**Deferred Items** rows in `.planning/STATE.md` from "Deferred (operator-gated)"
to "Verified live", and tick the `## Manual-Only Verifications` rows in
`.planning/phases/03-sandbox-deploy/03-VALIDATION.md`. Until then they remain
Deferred Items - the autonomous logic is already proven by the Plans 02-05 suite.
