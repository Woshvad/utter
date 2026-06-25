# Security review: long-lived gVisor resource-deploy architecture

Adversarial review of `RESOURCE-DEPLOY-DESIGN.md`. Every load-bearing claim was verified
against live source. The additive-second-profile shape is right and the env allowlist is
good, but there are real containment + fund-abuse holes, one of which contradicts the
SPEC's own threat model. **Read this alongside the design — design §3 (resource directly
on the control-plane) requires revision (see C1/C2).**

## Verdict

- **Trusted ECHO (Phase 1): safe-with-mitigations** — fix M5 (slug validation); the rest
  is acceptable because the echo code is ours, not adversarial.
- **Arbitrary UNTRUSTED resources (Phase 2+): NOT safe as written.** The root cause is that
  the trusted escrow gate is co-resident in the untrusted container (C1) while the
  facilitator authenticates no caller, and the design papers over this with an nftables
  "backstop" that in reality forbids the very reachability the in-process gate needs (C2).

## CRITICAL

### C1 — the escrow gate runs in-process inside the untrusted container
`injectGate` (`services/deployer/src/inject-x402.ts:117-137`) mounts `requirePayment` as
middleware in the **same process + netns** as the untrusted handler. Design §3 then puts
that container on `controlplane` to reach the facilitator. But the facilitator
authenticates **no caller** — `/verify`, `/settle`, `/release` (`services/facilitator/src/app.ts:131-325`)
have no token/mTLS/identity check; the only credential on the money path is the buyer's
EIP-712 signature. So adversary-controlled handler code (no gVisor escape needed — it shares
the process + netns) can open its own socket to the facilitator and:
- **forge `/release` strikes against any competitor resourceId** (only `isHex` validated) →
  drive rivals to the 5-strike pause threshold (marketplace griefing / denial-of-revenue);
- **replay-release other buyers' reservations** (no nonce ownership check);
- **self-settle on its own terms** — settle the full signed cap even on responses that
  should classify as malfunction/declared-error, i.e. **bypass the escrow gate that is the
  product's entire core value**, and inflate its own revenue up to each buyer's cap.
The on-chain `debit` re-clamps to `min(amount, maxAmount)` and the buyer's signature caps
it, so funds above the signed cap are safe — but everything below it is abusable.

**Required:** (a) move the gate to a **sidecar** off any network the untrusted container can
reach — only the sidecar joins `controlplane`; the untrusted container keeps the one-shot
egress posture (facilitator + RPC dropped, single data-proxy accept). The sidecar variant
is referenced at `inject-x402.ts:11` but the design ships in-process. (b) Regardless, add
**per-resource caller auth + authorization** on `/release` + `/settle` so a caller can only
act on its own resourceId.

### C2 — the "nftables backstop" contradicts the reachability the design requires
The design (§4.4) claims host nftables `policy drop` is an unchanged independent backstop.
But the live ruleset (`infrastructure/sandbox-host/nftables.rules.sh:57-68`,
`services/sandbox/src/egress/firewall.ts:42-48`) is `policy drop` whose single accept is the
data-proxy and which **explicitly drops the facilitator IP and Arc RPC** — exactly as SPEC
§9.5 mandates ("Block the Arc RPC, the facilitator, and the host"). So either: (1) the
operator applies the existing ruleset → the resource can't reach the facilitator → every
paid call 402s → the feature is down; or (2) the operator edits in a facilitator accept →
a SPEC-mandated control is removed and the "unchanged independent backstop" claim is false.
Both cannot hold.

**Required:** resolve C1 (sidecar) first; then the untrusted container keeps the
SPEC-mandated facilitator/RPC drop unchanged and only the **sidecar** gets facilitator
egress. Stop claiming the untrusted resource reaches the facilitator.

## HIGH

### H3 — per-resource credential/quota isolation hinges on a container header + a global allowlist
The data-proxy keys credential + quota off the container-supplied `x-resource-id` header
(`packages/data-proxy/src/proxy.ts:134`), bound by the scoped JWT `aud` (good). But
`DataProxyOpts.allowlist` is **process-global, not per-resource** (`proxy.ts:75,116`). If
all resources share one data-proxy (the MVP), resource A's allowlist is resource B's — a
resource scoped to one upstream can reach any co-tenant's allowed upstream. The design
understates this as a Phase-2 "fixture swap"; it must be a Phase-2 **gate**: per-resource
allowlist + quota resolved server-side from the verified resourceId.

### H4 — dropping the timeout-kill removes the only runaway control, unreplaced
The service profile enforces "no auto-kill" by field absence (good) but leans on
`restartPolicy: unless-stopped` + cgroup caps. cgroup caps bound *rate*, not *duration* or
*aggregate*; the gate's per-request timeout (`gate.ts:170`) doesn't touch background work
the handler spins. `unless-stopped` restarts a wedged/crash-looping handler forever, burning
host CPU/PID/mem continuously. **Required (not optional):** `on-failure` + max-retry/backoff,
a host-level global concurrency/CPU cap, and an idle/runaway reaper (SPEC §9.5 lists these
as mandatory).

## MEDIUM

### M5 — slug/route collisions (the one Phase-1 fix)
`buildTraefikDynamicConfig` (`services/deployer/src/traefik-config.ts:76-108`) keys the
router/service + `Host()` rule + `http://<slug>:8080` purely on `slug`, with **no slug
validation** there. A dotted/duplicate slug yields a colliding router (last-writer-wins) or
overlapping host rule → one resource silently serves another's paid traffic. **Required:**
validate + canonicalize the slug at `traefik-config.ts`, enforce slug uniqueness atomically
in the store before writing the file, and derive the container name + Traefik service name
from the same validated token (tie to the keccak resourceId). This is the only finding that
also matters for the trusted echo.

### M6 — redis + data-proxy share networks with untrusted code
Design §3 puts **redis on `controlplane` with every resource**. Redis AUTH is one shared
password; L3-reachable from untrusted containers, it is one leak from corrupting
reservations/nonces/strike counts beneath the facilitator. **Required:** redis on a network
shared **only** with the facilitator (a `facilitator-redis` net), never with resources;
ensure the data-proxy exposes only `/proxy` on `proxynet` (no admin/metrics surface).

### M7 — no socket-pinning (SSRF/DNS-rebind TOCTOU)
The proxy re-resolves + re-checks before connect (`proxy.ts:223-255`) but does not pin the
validated IP to the socket. For untrusted code that controls its upstream DNS record, the
recheck→connect window reaches metadata/RFC1918. **Required for untrusted code:** a
socket-pinning undici dispatcher (Phase 2), not an "operator decision."

## LOW

### L8 — Phase-1 echo shortcuts must be an explicit Phase-2 removal checklist
`unless-stopped` (H4) and the in-process gate (C1) carry straight into untrusted use if not
actively reverted. Each shortcut needs a Phase-2 removal item. Collapsing
creator/admin/treasury keys (open decision 6) on a host that also runs untrusted code puts
the registry-owner key on the same box as adversary code — call it out.

### L9 — the env allowlist relaxation is sound
`service-env.ts` allowlist + secret-shape guard is well-designed; `FACILITATOR_URL` as config
is not a secret, and the resource cannot rewrite its own static env (so no env-based SSRF).
The env relaxation is safe; it is the **in-process co-residence (C1)** that makes the config
value moot (untrusted code just opens its own socket). No extra env mitigation needed beyond
fixing C1.

## Minimum bar to make it safe for untrusted resources

1. **Sidecar gate** off any net the untrusted container can reach; only the sidecar joins
   `controlplane`; the untrusted container keeps the one-shot nftables ruleset unchanged. (C1, C2)
2. **Per-resource caller auth + authorization** on `/release` + `/settle`. (C1)
3. **Per-resource allowlist + quota** resolved server-side from the verified resourceId. (H3)
4. **`on-failure` + backoff + host concurrency cap + runaway reaper** as requirements. (H4)
5. **Redis off any resource-shared network.** (M6)
6. **Socket-pinning dispatcher** for untrusted upstream selection. (M7)

Until 1–3 land, the platform's central claim — untrusted code is contained and cannot abuse
funds or grief other resources — does not hold under this design. Phase 1 (trusted echo)
needs only M5.
