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

## Acceptance 3 - live HTTPS 402->200 paywalled deploy (DEP-01 / DEP-02 / PRX-02)

**Goal:** the echo bundle is reachable over real wildcard TLS at
`https://<slug>.resources.<domain>`, returns **402 unpaid** and **200 after a
paid call**, and a non-allowlisted host is unreachable from the container.

```bash
# 1. Fund the buyer EOA (native USDC) at https://faucet.circle.com and set the keys
#    + the domain in .env.local (gitignored - never commit a real key):
#      DEPLOY_DOMAIN          = your domain (the apex is resources.<domain>)
#      TEST_BUYER_PRIVATE_KEY = the funded buyer EOA key
#      ARC_RPC_URL            = https://rpc.testnet.arc.network  (optional; default)
# 2. Run the operator-gated live deploy (deploys the echo bundle behind the wildcard
#    edge, then curls 402-unpaid -> 200-paid over HTTPS + asserts PRX-02):
node services/deployer/src/live-deploy.ts
```

`liveDeployEcho` (`services/deployer/src/live-deploy.ts`) generates the per-resource
Traefik dynamic config for `<slug>.resources.<domain>`, then:

- curls `https://<slug>.resources.<domain>/echo` with **no X-PAYMENT** -> asserts **402**,
- signs a real `DebitAuthorization` and re-curls with `X-PAYMENT` -> asserts **200** + the `X-PAYMENT-RESPONSE` receipt over HTTPS,
- attempts a non-allowlisted host from inside the container -> asserts it is unreachable (**PRX-02**).

**Pass:** the script prints `402(unpaid)->200(paid); PRX-02 unreachable=true`.
**Fail:** any of the three assertions throws - the live paywall, the wildcard cert,
or the egress containment is not holding in production.

---

## After running

Once all three acceptances pass on the provisioned host, update the three
**Deferred Items** rows in `.planning/STATE.md` from "Deferred (operator-gated)"
to "Verified live", and tick the `## Manual-Only Verifications` rows in
`.planning/phases/03-sandbox-deploy/03-VALIDATION.md`. Until then they remain
Deferred Items - the autonomous logic is already proven by the Plans 02-05 suite.
