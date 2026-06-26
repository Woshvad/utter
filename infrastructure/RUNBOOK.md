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
docker build -t utter/blocked-host-probe:latest infrastructure/sandbox-host/blocked-host-probe/

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
no facilitator route + no caller-auth token (it joins ONLY its per-resource
`utter_pairnet_<slug>`, an internal:true bridge - NOT the shared `proxynet`); the
sidecar (only) reaches the facilitator (on `controlplane`) and reverse-proxies
validated calls to the handler over the SAME per-slug pairnet, by inspected IP
(runsc has no Docker DNS). Traefik routes to the SIDECAR. The per-resource pairnet
(quick 260625-mwb) replaces the old shared proxynet for the handler so no sibling
handler can address it at L3.

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

# 3. Apply the host nftables egress rules. This is now a MINIMAL host-output
#    denylist with policy ACCEPT (host self-preservation only): it can never lock
#    the operator out and never breaks host->container traffic. It is NOT the
#    container boundary - the container boundary is the per-resource internal:true
#    pairnet (PRX-02), already proven live. The script needs only ARC_RPC_IP (so the
#    host itself does not reach the Arc RPC directly; the facilitator CONTAINER
#    reaches it via forwarded traffic and is unaffected) and UTTER_SANDBOX_HOST=1:
ARC_RPC_IP=$(getent hosts rpc.testnet.arc.network | awk '{print $1}') \
  UTTER_SANDBOX_HOST=1 sudo -E bash infrastructure/sandbox-host/nftables.rules.sh

# 4. Run the pair deploy WITH the live egress probe. UTTER_SANDBOX_HOST=1 lets the
#    orchestrator build + run the containers; UTTER_RUN_EGRESS_PROBE=1 arms PRX-02
#    (skipped in Phase 1). Run from the repo root (.env.local loads from there):
UTTER_SANDBOX_HOST=1 UTTER_RUN_EGRESS_PROBE=1 node \
  --import ./scripts/ts-resolver.mjs --experimental-strip-types \
  services/deployer/src/live-deploy.ts
```

The pair deploy then: mints the facilitator caller-auth token, launches the
HANDLER (on its per-resource `utter_pairnet_<slug>` ONLY) + the SIDECAR (on
`ingress`+`controlplane`+`utter_pairnet_<slug>`, NOT the shared proxynet),
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
RFC1918 host, or host loopback. The cross-tenant free-compute blocker (item #1) is now
RESOLVED by per-resource pairnet isolation (quick 260625-mwb); one LOW lifecycle item
(#2) remains. Read both before arming an UNTRUSTED multi-tenant host.

### 1. Flat shared proxynet (cross-tenant free compute) - RESOLVED (quick 260625-mwb)

ORIGINAL GAP: every gate-less HANDLER joined the single shared `proxynet` with Docker
inter-container communication on, so an adversary's handler could reach a SIBLING
tenant's gate-less handler at L3 and POST its `/call` directly with NO escrow
reservation. The sibling handler has no auth on `/call` (the gate lives only in the
sidecar by the C1 split), so this was free compute charged against another creator's
resource. An adversary handler could also laterally probe sibling sidecars on the bridge.

IMPLEMENTED DESIGN (per-resource network isolation at the Docker layer):

- Each pair gets a DEDICATED internal bridge `utter_pairnet_<slug>` (`Internal: true`),
  created BEFORE the handler container so it is the handler's create-time NetworkMode
  (`orchestrate.ts` `ensurePairNetwork` / `pairnetName`). Labeled `io.utter.kind=pairnet`.
- The HANDLER joins ONLY its `utter_pairnet_<slug>`. It is NOT on the shared `proxynet`,
  nor controlplane/ingress. No sibling tenant's handler shares its bridge, so a sibling
  handler IP is not routable from inside it.
- The SIDECAR joins `ingress` (Traefik in) + `controlplane` (the facilitator) + the same
  `utter_pairnet_<slug>` (its own handler), and DROPS the shared `proxynet`. It reaches
  its handler by inspected IP on the shared pairnet (runsc has no Docker DNS).
- Cross-tenant handler-to-handler is blocked at the DOCKER layer by disjoint internal
  bridges. The pairnet lifecycle is reaped on the LAST container of a slug
  (`reapResourceContainer`, the reconcile per-container seam) and via `reapResourcePair`,
  with an orphan-network GC sweep (`reapOrphanPairNetworks`, a per-tick reconcile hook)
  as the safety net so a crashed/raced pairnet cannot leak host bridges. The per-container
  reap is self-sufficient: `removePairNetwork` gates off the network's OWN endpoint list
  (`network.inspect().Containers`) and removes the bridge only when zero endpoints remain,
  so there is no `listContainers` timing dependency or race; the GC is the backstop.

HARD PREREQUISITE - GLOBAL SLUG UNIQUENESS (M5):

- The isolation guarantee depends on every resource having a GLOBALLY-UNIQUE slug. Two
  different resourceIds on ONE slug would derive the SAME `utter_pairnet_<slug>` and thus
  CO-TENANT a single internal bridge - re-opening exactly the cross-tenant free-compute
  HIGH this section closes. Global slug uniqueness is therefore a hard prerequisite for
  multi-tenant isolation, not a nicety.
- NETWORK-LAYER ENFORCEMENT (quick 260625-mwb, FIX C): `ensurePairNetwork` stamps the
  owning resourceId onto the pairnet (`io.utter.resource-id` label). On a redeploy that
  hits the already-exists (409) path it inspects the existing pairnet and reads that
  label: a MATCH is an idempotent same-resource redeploy; a MISMATCH THROWS a loud Error
  (`already owned by a different resource`) and refuses to launch, converting a slug
  collision into a fail-loud at the network layer instead of a silent co-tenant. An
  unlabeled legacy pairnet (created before this guard) is adopted. This is the
  network-layer backstop; the slug allocator MUST still enforce uniqueness upstream.

HONEST ENFORCEMENT BOUNDARY (do not over-claim):

- The host nftables ruleset (`nftables.rules.sh`) is `type filter hook output` - it
  filters HOST egress by destination IP and does NOT see intra-bridge sibling forwarding.
  So the disjoint per-slug pairnet is the SOLE enforcement of handler-sibling isolation.
  There is NO nftables FORWARD-path backstop today; do not claim one.
- ACCEPTED RESIDUAL (LOW): sidecars still share `ingress`, so sidecar A can reach sidecar
  B at L3. Sidecars are first-party trusted code and the untrusted handler cannot reach
  `ingress` at all, so this is a trusted-to-trusted surface, not a free-compute vector.
- DEFERRED (next increment): the handler->data-proxy egress path is not wired yet (the
  echo makes no upstream calls; there is no `HTTP_PROXY`/`172.30.0.10` injection today).
  When untrusted egress lands, attach the data-proxy to each `utter_pairnet_<slug>` (or
  inject `DATA_PROXY_URL`); note this is per-pair re-plumbing, not a shared-proxynet hop.

LIVE ACCEPTANCE (PRX-02, operator-gated): from handler A, run `createLiveSiblingProbe`
asserting a sibling handler IP and a sibling sidecar IP are UNREACHABLE (the own
data-proxy is the only allowed peer). The autonomous suite proves the probe logic with
an injected `connectProbe`; the live half is operator-gated on the provisioned gVisor
host exactly like `createLiveHostProbe`.

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

PAIRNET GC BACKSTOP (quick 260625-mwb, FIX E): when the Phase-3 reconcile-loop bootstrap
lands it should pass `reapOrphanNetworks: () => reapOrphanPairNetworks(docker)` as the
per-tick backstop hook. The per-container reap (`reapResourceContainer`) is now
self-sufficient - `removePairNetwork` removes the pairnet exactly when its last endpoint
detaches, off the network's own endpoint list - so this GC only catches crash/race
stragglers (a pairnet that outlived its containers because the process died between the
container remove and the network remove). It is a safety net, not the primary teardown.

---

## After running

Once all three acceptances pass on the provisioned host, update the three
**Deferred Items** rows in `.planning/STATE.md` from "Deferred (operator-gated)"
to "Verified live", and tick the `## Manual-Only Verifications` rows in
`.planning/phases/03-sandbox-deploy/03-VALIDATION.md`. Until then they remain
Deferred Items - the autonomous logic is already proven by the Plans 02-05 suite.
