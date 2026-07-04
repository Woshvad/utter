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

## Generated (untrusted) bundle deploy - DEPLOY_BUNDLE_PATH + studio end to end

> This section BUILDS ON the Phase 2 pair deploy above. It assumes the SAME
> six-network compose full-stack recreate (no single-service filter), the SAME host
> nftables denylist, and Acceptances 1-3 already passing on the provisioned gVisor
> host. It does NOT re-document those steps; do the Phase 2 section first, then apply
> only the deltas below.

**Goal:** deploy a GENERATED (untrusted) bundle through the SAME proven sidecar/handler
pair path, selected by `DEPLOY_BUNDLE_PATH`, then run the same flow end to end from the
studio. The untrusted handler.ts is gated before any build; the trusted sidecar holds the
money path. A committed sample bundle lives at
`services/deployer/examples/generated-sample` so this section has a real, deployable
target.

### Part A - prereqs (deltas over the Phase 2 pair section)

This uses the SAME `.env.local` keys as the Phase 2 pair deploy: `DEPLOY_DOMAIN`,
`TEST_BUYER_PRIVATE_KEY`, `REGISTRY_ADMIN_PRIVATE_KEY`, `PLATFORM_TREASURY`,
`FACILITATOR_AUTH_SECRET`, `DEPLOY_BASE_IMAGE_NODE`, and optional `ARC_RPC_URL`. No new
key is required for the standalone CLI deploy.

The untrusted bundle NEVER sets the slug, the on-chain resourceId, or the pricing. The
OPERATOR sets those via ENV: `DEPLOY_SLUG` (required), optional `DEPLOY_RESOURCE_LABEL`
(derives the resourceId; defaults to the slug), and the `PRICE_*` / `MAX_RESPONSE_BYTES`
terms. ONLY `openapi.json` is read FROM the bundle (the classifier schema the sidecar
compiles). Everything else is trusted control-plane input.

### Part B - standalone CLI deploy of the sample (from the repo root)

```bash
DEPLOY_BUNDLE_PATH=services/deployer/examples/generated-sample DEPLOY_SLUG=gen-sample \
  UTTER_SANDBOX_HOST=1 UTTER_RUN_EGRESS_PROBE=1 node \
  --import ./scripts/ts-resolver.mjs --experimental-strip-types \
  services/deployer/src/live-deploy.ts
```

Setting `DEPLOY_BUNDLE_PATH` selects `deployGeneratedBundle` (absent, `liveDeployEcho`
runs the echo deploy instead). The generated path GATES FIRST, fail-closed: it runs
`gateGeneratedBundle` over the in-memory bundle before any file is written or built. It
then builds the handler image from the bundle (the esbuild-shim path,
`bundleGeneratedHandler`, which re-gates the bundle structurally before esbuild) plus the
trusted sidecar; registers the resource on-chain (the resourceId derives from
`DEPLOY_RESOURCE_LABEL`, or `DEPLOY_SLUG` when the label is unset); proves 402 -> 200
THROUGH the sidecar; asserts the on-chain `Debited` split; and runs PRX-02 against the
GENERATED handler because `UTTER_RUN_EGRESS_PROBE=1` is set.

**Expected:** the gate passes, the handler + sidecar images build, the resource registers
(or logs "already active" on a redeploy), 402 then 200 with the receipt, the PRINTED
settle tx + its ArcScan link, and PRX-02 `unreachable=true`.

**Fail:** any assertion throws - the gate, the build, the live paywall, the on-chain
split, or the egress probe is not holding.

### Part C - adversarial gate proof (MUST run, fail-closed)

```bash
DEPLOY_BUNDLE_PATH=services/sandbox/test/fixtures/malicious DEPLOY_SLUG=gen-malicious \
  UTTER_SANDBOX_HOST=1 node --import ./scripts/ts-resolver.mjs --experimental-strip-types \
  services/deployer/src/live-deploy.ts
```

**Expected:** a `BundleGateError` naming the disallowed `net` import and the `process.env`
enumeration (the malicious fixture's two static violations), exit 1, and NO image built /
NO container launched. The gate runs before any build, so `deployResource` is never
reached.

**Fail:** the run produces ANY artifact or reaches the build - the fail-closed gate is not
holding. A malicious bundle MUST be rejected before any artifact is produced.

### Part D - studio end to end

Set `DEPLOYER_AUTH_SECRET` (`openssl rand -hex 32`, at least 32 chars) in `.env.local`
(gitignored, NEVER committed). Use the SAME value on the deployer server AND the studio.

Run the deployer server with the host gate + the chain env. It serves `POST /deploy` on
`:8788`:

```bash
DEPLOYER_AUTH_SECRET=... UTTER_SANDBOX_HOST=1 node \
  --import ./scripts/ts-resolver.mjs --experimental-strip-types \
  services/deployer/src/server.ts
```

Run the studio live, pointed at the deployer:

```bash
STUDIO_DATA_ADAPTER=live DEPLOYER_URL=http://localhost:8788 DEPLOYER_AUTH_SECRET=... \
  FACILITATOR_URL=... DEPLOY_DOMAIN=... pnpm -C apps/studio dev
```

In the UI: utter -> Create -> the build stream shows Generate -> Deploy / Verify / Mint
(streamed from the real deployer SSE) -> Publish -> Live; the resource goes live (402 ->
200) and a paid call settles on-chain. The KEYSTONE: the studio passes
`resourceLabel = utter:resource:<slug>`, so the deployer's derived resourceId equals the
studio's escrow / payTo id (a single source of truth).

**Acceptance:** (1) the benign sample -> the gate passes, the images build, 402 -> 200, an
on-chain `Debited`, PRX-02 `unreachable=true`; (2) the malicious bundle -> a
`BundleGateError` before any build; (3) studio create -> the SSE stream reaches Live, the
resource is live, and a paid call settles. Container-only: NO host firewall changes beyond
the Phase 2 denylist.

**Fail:** any of the three does not hold - the gate, the build, the SSE stream, the live
paywall, or the on-chain settle.

Security notes: `DEPLOYER_AUTH_SECRET` and all keys live ONLY in `.env.local` (gitignored)
and are NEVER logged. `POST /deploy` is Bearer-authed and fail-closed: a 503 when the
secret is unset, a 401 on a bad bearer. The gate runs before any build. The handler stays
gate-less and token-less; only the trusted sidecar holds the facilitator token.

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

### 2. H4 lifecycle loop - auto-started on the gVisor host (RESOLVED)

The Phase 3 reconcile-loop bootstrap has landed. `services/deployer/src/server.ts`
`start()` builds the loop via `buildReconcileLoop` and calls `loop.start()` whenever
`UTTER_SANDBOX_HOST=1` resolves a real docker handle. So on the provisioned host,
orphan-reap (T-03-19), runaway quarantine (`DEFAULT_RUNAWAY_POLICY`), the
stale-deploying crash-recovery quarantine, and the global host concurrency cap all run
against live pairs every tick (`RECONCILE_INTERVAL_MS`, default 15000). Off-host
(dev/test, `UTTER_SANDBOX_HOST` unset) `resolveDockerHandle()` returns undefined, so the
loop is never constructed and boot stays byte-unchanged.

The wiring is pair-aware: `listResourceContainers` returns BOTH the handler and the
sidecar under the same `io.utter.resource-id` label, and the reap accounts for the
sibling. The loop also passes `reapOrphanNetworks: () => reapOrphanPairNetworks(docker)`
as the per-tick pairnet GC backstop (quick 260625-mwb, FIX E): the per-container reap
(`reapResourceContainer`) is self-sufficient - `removePairNetwork` removes the pairnet
exactly when its last endpoint detaches, off the network's own endpoint list - so this
GC only sweeps crash/race stragglers (a pairnet that outlived its containers because the
process died between the container remove and the network remove). It is a safety net,
not the primary teardown. The loop interval is unref'd so it never keeps the process
alive, and graceful shutdown stops the loop before the store client closes.

Operator note: nothing to wire by hand. Set `UTTER_SANDBOX_HOST=1` in the deployer's
environment (PROVISION.md §3) and the loop starts itself; the boot log prints either
`reconcile loop started, interval <ms>ms` or `reconcile loop not started (no sandbox host)`.

---

## After running

Once all three acceptances pass on the provisioned host, update the three
**Deferred Items** rows in `.planning/STATE.md` from "Deferred (operator-gated)"
to "Verified live", and tick the `## Manual-Only Verifications` rows in
`.planning/phases/03-sandbox-deploy/03-VALIDATION.md`. Until then they remain
Deferred Items - the autonomous logic is already proven by the Plans 02-05 suite.

---

## Host the studio at app.utter.technology (no tunnel)

These steps put the Utter studio behind the existing Traefik at
https://app.utter.technology with automatic TLS and no SSH tunnel. The studio is
a trusted control-plane service placed on ingress/controlplane/upstreamnet only;
it never joins edge, proxynet, or redisnet, so it does not weaken the resource or
money-path isolation.

1. DNS. Create a DNS A record `app.utter.technology` pointing at the host public
   IP. Traefik derives the cert domain from the router Host rule, so a single A
   record is enough; no wildcard SAN is needed for this host.

2. Secrets in .env.local. Ensure `.env.local` (gitignored, never committed) has:
   - `SESSION_SECRET` at least 32 chars, for example `openssl rand -hex 32`. The
     production studio fails closed without it: session.server.ts refuses to start
     with a short or missing secret rather than fall back to the dev key.
   - `DEPLOYER_AUTH_SECRET` the Bearer the studio presents to the host deployer.
   - `DEPLOY_DOMAIN` the deploy domain the agent-card URLs are built from.
   - `ARC_RPC_URL` the Arc RPC endpoint (optional; the chain default is used when
     blank).
   - `NAMECHEAP_API_USER` and `NAMECHEAP_API_KEY` the same DNS-01 credentials the
     wildcard cert already uses, so the le resolver can issue the studio cert.

3. Host deployer. Make sure the deployer host process is running on :8788 and that
   8788 is NOT open to the public internet (host firewall). The studio reaches it
   only over the docker bridge via host.docker.internal; POST /deploy is
   Bearer-authed by DEPLOYER_AUTH_SECRET regardless.

4. Build and bring up only the studio:
   `docker compose -f infrastructure/docker-compose.yml --env-file .env.local up -d --build studio`
   Traefik picks up `dynamic/studio.yml` through the file provider with no restart
   and issues the cert on the first request, which can take a few seconds.

5. Verify. Browse https://app.utter.technology and run
   `curl -I https://app.utter.technology`, expecting a 200 or 302 with a valid
   Let's Encrypt cert. The very first request may briefly 404 or show a
   cert-pending state while ACME completes; retry after a few seconds.

### Troubleshooting: the Deploy step shows "fetch failed"

When Generate reaches "done" (bundle generated and four-gate validated) but Deploy
fails, the build stream now names the cause, for example
`deployer POST http://host.docker.internal:8788/deploy could not be reached
(ECONNREFUSED): ...`. "fetch failed" is a connection-level error: the studio
container could not reach the deployer host process at all. Work through:

1. Is the deployer host process running and listening on :8788? Start it on the host
   (not in a container - it needs the host Docker daemon + runsc). Confirm with
   `curl -s http://localhost:8788/health` on the host, expecting
   `{"ok":true,"service":"deployer"}`.

2. Can the studio CONTAINER reach it? The container reaches the host over the docker
   bridge via host.docker.internal, not localhost. Test from inside the container:
   `docker compose -f infrastructure/docker-compose.yml exec studio \
     wget -qO- http://host.docker.internal:8788/health`
   - ECONNREFUSED: the deployer is not listening on all interfaces. It now binds
     0.0.0.0 by default; if you set HOST, make sure it is not 127.0.0.1.
   - timeout: a host firewall is dropping the docker subnet -> host:8788. Allow the
     docker bridge subnet to reach the host on 8788 (keep 8788 closed to the public
     internet). The /deploy endpoint is Bearer-authed and gate-first regardless.
   - ENOTFOUND host.docker.internal: the `host.docker.internal:host-gateway`
     extra_host is missing; it is set on the studio service in the compose file.

3. Is DEPLOYER_URL correct? Inside the container localhost is the container itself,
   not the host. Leave DEPLOYER_URL unset to use the
   `http://host.docker.internal:8788` default, or set it explicitly to that. Do NOT
   set it to http://localhost:8788.

4. Is DEPLOYER_AUTH_SECRET set on BOTH sides? The same value must be in the studio
   env and the deployer host process env, or POST /deploy returns 401/503 (that
   shows as an HTTP error in the stream, not "fetch failed").

## Host the marketplace (agent discovery)

These steps put the Utter marketplace behind the existing Traefik at
https://marketplace.utter.technology with automatic TLS, so external agents can
discover deployed resources and fetch their agent cards, and so the studio's
publish step lists each deployed resource in-compose. The marketplace is a trusted
control-plane service placed on ingress + controlplane only; it never joins edge,
proxynet, redisnet, or upstreamnet, so it does not weaken the resource or
money-path isolation. Its publish endpoint is Bearer-gated (fail-closed); GET
/resources and the card route are intentionally public for agent discovery.

1. DNS. Create a DNS A record `marketplace.utter.technology` pointing at the host
   public IP. Traefik derives the cert domain from the router Host rule, so a single
   A record is enough; no wildcard SAN is needed for this host. The `marketplace`
   host is reserved and must not be used as a resource slug.

2. Secrets in .env.local. Ensure `.env.local` (gitignored, never committed) has:
   - `MARKETPLACE_AUTH_SECRET` the shared Bearer the studio presents to the
     marketplace POST /resources endpoint. Use the SAME value for the studio and the
     marketplace; the studio reads the same `MARKETPLACE_AUTH_SECRET`.
   - `DATABASE_URL` the durable index/card/moderation store. The production
     marketplace fails closed without it (resolveMarketplaceStores refuses an
     in-memory store in production).
   - `NAMECHEAP_API_USER` and `NAMECHEAP_API_KEY` the same DNS-01 credentials the
     wildcard cert already uses, so the le resolver can issue the marketplace cert.

3. Build and bring up only the marketplace:
   `docker compose -f infrastructure/docker-compose.yml --env-file .env.local up -d --build marketplace`
   Traefik picks up `dynamic/marketplace.yml` through the file provider with no
   restart and issues the cert on the first request, which can take a few seconds.

4. Verify. Run `curl -I https://marketplace.utter.technology/health`, expecting a
   200 with a valid Let's Encrypt cert. The very first request may briefly 404 or
   show a cert-pending state while ACME completes; retry after a few seconds. After
   a real create in the studio, the resource card is fetchable at
   `https://marketplace.utter.technology/<resourceId>/.well-known/agent-card.json`.

The studio now reaches the marketplace at `http://marketplace:8789` by default over
the shared controlplane net, so no `MARKETPLACE_URL` override is needed in compose;
set `MARKETPLACE_URL` only to point the studio at a non-compose marketplace host.

## Enable real AI generation

This turns the studio Generate step from the deterministic scaffold generator into
a real Claude model call. It assumes the studio is already hosted per the section
above. Real generation is purely opt-in: with no key set the studio keeps using
the deterministic scaffold generator and reaches no model or network path, so you
can run the platform without it and switch it on later with no code change.

1. API key in .env.local. Put a real Anthropic API key in `.env.local` as
   `ANTHROPIC_API_KEY`. It must be a real API key from the Anthropic console, in
   the `sk-ant-...` format. A Claude Code OAuth token is NOT an API key and will
   401 for SDK use; the Agent SDK needs a real API key. The key is never baked into
   the image or logged; it is supplied at runtime through the empty compose default.

2. Model, optional. The default model is `claude-sonnet-5`, the reliable + fast +
   affordable balance for handler codegen. Set `DEFAULT_MODEL` in `.env.local` to
   `claude-haiku-4-5-20251001` (cheapest) or `claude-opus-4-8` (priciest/slowest;
   it over-reasons and gives no convergence gain on this task, so it is not
   recommended).

3. Config dir, normally untouched. `CLAUDE_CONFIG_DIR` defaults to
   `/tmp/utter-claude` inside the container, an empty writable dir so the Agent SDK
   uses the API key and never a stray host OAuth token. The operator normally does
   not set it.

4. Rebuild only the studio:
   `docker compose -f infrastructure/docker-compose.yml --env-file .env.local up -d --build studio`

5. Verify by a real create in the browser. Open the studio, describe an endpoint,
   and run Generate. It now produces a real handler from the model. Safety invariant:
   the generated bundle still passes the four-gate validateBundle plus the deployer
   gate plus gVisor isolation, exactly as before. Non-conforming model output is
   rejected and never deployed; this work does not change any of those gates.

Cost note. Each create spends Anthropic tokens. The studio reaches
api.anthropic.com over upstreamnet, its only egress network. Larger models cost
more per create, so leave the default haiku model in place unless you need the
extra quality.
