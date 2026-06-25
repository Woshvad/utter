# Design: deploying Utter resources as long-lived, gVisor-isolated, Traefik-routed, egress-controlled services

Status: design for review. No code written. Reconciles four design briefs (reuse map, network/security topology, run-profile reconciliation, registration + studio integration) into one buildable plan.

Authoritative references this design pins: `Utter-SPEC.md` §9.3 (port 8080), §9.5 (sandbox isolation 336-346), §12 (lifecycle 496-500), §19 (threat model 627-640); `CLAUDE.md` engineering rules (escrow gate, runsc-only boundary, no direct chain access from the sandbox).

---

## 1. Problem and the core tension

Utter's security model was written for a **one-shot untrusted handler**. `buildRunSpec` (`services/sandbox/src/runner/runspec.ts:91`) bakes three defaults that are correct for *run-to-completion verification* and fatal for a *persistent service*:

- `network: "none"` (`runspec.ts:107`) — the container has no route; the egress firewall attaches the only path host-side.
- `env: {}` typed `Record<string, never>` (`runspec.ts:122`, `types.ts:85`) — any env key is a compile error, so no platform config and no secrets can enter the container.
- a runner that **kills the container at `timeoutSeconds`** (`gvisor.ts:50-58`) and whose only handle method is `wait()` for an exit code (`types.ts:88-96`).

The product goal needs the opposite of all three. A **deployed resource** is a long-lived HTTP server that:

1. Traefik must reach by name over the cluster network (so it needs a network and a stable container name),
2. must itself call the facilitator's `/verify` + `/settle` to drive the escrow gate (so it needs a control-plane route and a small config env: `FACILITATOR_URL`, `RESOURCE_ID`, `PORT`, pricing),
3. must **not** be killed at a deadline (it stays up; it restarts on failure),
4. must still be the **untrusted, gVisor-isolated, default-deny-egress** container the threat model demands — because for AI-generated resources, the code inside it is adversary-controlled.

**The core tension:** requirements (1)-(3) are exactly what `network:"none"` + `env:{}` + deadline-kill forbid, yet requirement (4) is the entire reason those defaults exist. Naively relaxing the one-shot spec to add a network and env would weaken the invariant that protects every untrusted resource at once, and would break the invariant tests in `runspec.test.ts` that prove it.

**The resolution, in one sentence:** introduce a **second, additive run profile** for long-lived services that keeps every *isolation* flag identical to the one-shot profile and relaxes only *reachability* (named internal networks, not `"none"`) and *config* (a secret-guarded non-secret env allowlist, not arbitrary env) — and prove via Docker network topology and host nftables that "internal network ≠ internet egress" and "config ≠ secrets", so the relaxations buy reachability without buying a way out.

The map brief confirms the code-side gap precisely: the repo has all the **pure generators** (spec builder, Traefik config, image builder, x402 inject, reconcile diff) and the **hardened single-shot runner**, but nothing today launches a long-lived named networked container, writes the Traefik file, mints a per-deploy proxy token, or registers the resource on-chain. `live-deploy.ts` is a proof harness that curls an already-running edge; it never creates a container or writes a file.

---

## 2. Two run profiles

The design keeps **two distinct container shapes** that the prompt's goal otherwise conflates. They share an isolation surface and differ on exactly four deployment fields.

### 2.1 One-shot untrusted-handler profile (UNCHANGED)

Used for build/probe/verification: a single invocation that runs to completion. Produced by `buildRunSpec` → `RunSpec` → `toDockerodeCreateOptions`, launched by `GvisorRunner.run`, killed at `timeoutSeconds`.

This profile is **not touched**. `buildRunSpec`, `RunSpec`, `toDockerodeCreateOptions`, and `runspec.test.ts` stay byte-for-byte as they are. That is the proof that the one-shot invariants do not regress: the existing code path is untouched, so the existing tests pass unchanged.

### 2.2 Long-lived resource-service profile (NEW, additive sibling)

A separate type, builder, dockerode translator, and runner method — mirroring the established two-backend pattern (gvisor / docker-dev sharing translators). New artifacts (run-profile brief §8):

| File | Change |
|---|---|
| `services/sandbox/src/runner/types.ts` | **Add** `ResourceServiceSpec`, `ServiceHandle`, `ServiceRestartPolicy`; extend `RunError.phase` with `"start-service"`; add an **optional** `startService?(spec)` to `SandboxRunner`. `RunSpec` untouched. |
| `services/sandbox/src/runner/service-env.ts` | **New.** `SERVICE_ENV_ALLOWLIST`, `buildServiceEnv`, `ServiceEnvViolation` — the env allowlist + secret guard. |
| `services/sandbox/src/runner/service-runspec.ts` | **New.** `buildResourceServiceSpec` + options; reuses `RunLimits`, `runtimeFor`, `hardenTmpfs`, `DEFAULT_TMPFS`. |
| `services/sandbox/src/runner/service-dockerode-spec.ts` | **New.** `toServiceDockerodeCreateOptions` — copies the hardening block, adds name/env/NetworkMode/RestartPolicy/port. `dockerode-spec.ts` untouched. |
| `services/sandbox/src/runner/gvisor.ts` | **Add** `startService` (detached, no deadline, runsc-or-refuse). `run`/`stop`/`logs`/`inspect` untouched. |
| `services/sandbox/src/runner/docker-dev.ts` | **Add** `startService` (runc, NOT a boundary). |
| `services/sandbox/src/runner/runspec.ts` | **Minimal:** `export` `hardenTmpfs` + `DEFAULT_TMPFS` (or lift to a tiny `harden.ts`). No behavior change. |
| `services/sandbox/src/index.ts` | **Add** the new exports. |
| `services/sandbox/test/service-runspec.test.ts`, `service-env.test.ts` | **New** invariant + guard tests. `runspec.test.ts` unchanged. |

### 2.3 What differs and what stays hardened

The `ResourceServiceSpec` mirrors `RunSpec` field-for-field on every hardening flag, keeping the literal types so an invariant test can assert they are identical to the one-shot spec.

**Stays hardened (identical literals, re-asserted in `service-runspec.test.ts`):**
- `runtime: "runsc"` for the gvisor backend — the **gVisor boundary is never dropped** for a deployed resource (the same runsc-or-refuse guard as `run`, `gvisor.ts:40-46`).
- `readonlyRootfs: true`, `tmpfs` forced `noexec,nosuid` (reusing `hardenTmpfs`/`DEFAULT_TMPFS`).
- `capDrop: ["ALL"]`, `capAdd: []` — the network/env relaxation buys back **no capability**.
- `securityOpt: ["no-new-privileges:true"]`.
- `pidsLimit` / `memoryBytes` / `cpus` / optional `storageOptSize`.
- **Never** `privileged`, **never** `network:"host"`.

**Differs (exactly four deployment fields):**

1. **`network`: `"none"` → a named internal Docker network** (a plain `string`; builder rejects `"host"` and `"none"`). A service must be DNS-reachable by Traefik and reach the facilitator; `"none"` makes both impossible.
2. **`env`: `{}` → a secret-guarded non-secret config map** (`Record<string,string>`, validated by `buildServiceEnv`).
3. **`name`: added** — a stable, namespaced container name (`^utter_res_[a-z0-9-]+$`) so Traefik DNS resolves it and reconcile can track it by label.
4. **`restartPolicy`: added** — default `unless-stopped`. **And, critically, there is no `timeoutSeconds` field on the type at all** — the "does not auto-kill" property is enforced by *absence*, so no future edit can flip a flag to re-enable the deadline kill without re-adding the field.

`startService` is **detached**: it creates → starts → returns a `ServiceHandle` (no `wait()`), installs **no `setTimeout` deadline**, and surfaces a failed start through the existing non-secret `RunError` sink (new phase `"start-service"`). `stop(id)` / `logs(id)` / `inspect(id)` are profile-agnostic and serve both unchanged.

#### The env allowlist + secret guard (`service-env.ts`) — the security heart of relaxation 2

Two layers, both required, deny-by-default:

```
SERVICE_ENV_ALLOWLIST = [
  FACILITATOR_URL,   // non-secret base URL
  RESOURCE_ID,       // on-chain keccak identity (public)
  PORT,              // listen port
  PRICE_AMOUNT, PRICE_ASSET, PRICE_SCHEME, PRICE_MAX,  // public pricing terms
]
```

- **Layer A — closed allowlist.** Any key not in the set is rejected at build time. Deliberately absent: every secret-bearing key from `.env.example` (`DATA_PROXY_TOKEN_SECRET`, `RELAYER_SIGNER_KEYS`, `*_PRIVATE_KEY`, `SESSION_SECRET`, `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `DNS_API_TOKEN`).
- **Layer B — secret-shaped guard.** Even if a key were mistakenly added to the allowlist later, a key-name denylist (`/(_KEY|SECRET|TOKEN|PASSWORD|PRIVATE|MNEMONIC|SEED|CREDENTIAL|SIGNER)/i`) plus value-shape checks (hex64 private key, `sk-`, PEM block, `AKIA`, high entropy) reject it. Reuses the patterns already trusted in `prepublish/secret-scan.ts:31-42`. `ServiceEnvViolation` carries only the **key name and reason — never the value** (no secret in an error).
- **Entropy false-positive fix:** `RESOURCE_ID` and `PRICE_ASSET` (USDC `0x3600…0000`) are high-entropy public constants. The value guard always runs the named-pattern checks but applies the entropy pass **only to keys not in a `KNOWN_PUBLIC_CONSTANT` subset**, mirroring `scanSecrets`'s `entropy:false` option for declarative values.

The data-proxy still mints its **short-lived scoped token at request time** and injects it per-request — exactly as the one-shot profile relies on. The token is **never** part of the service's static env.

---

## 3. Network topology

SIX Docker networks on the provisioned gVisor host. The load-bearing distinction is `internal: true` — a Docker `internal` network has **no default gateway**, so members cannot reach the internet at all, regardless of any in-container route. The current `infrastructure/docker-compose.yml` now implements exactly this layout (Rework 8, wave BD).

> **M6 correction (Rework 8, supersedes the original table below).** The first draft of this table put **redis on `controlplane` shared with every resource**, and routed `resource → facilitator`/`facilitator → redis` over that one net. That is the M6 bug: it placed redis on a resource-reachable network, giving a compromised resource L3 reachability to the cache/store. The corrected topology below moves redis onto a dedicated **`redisnet`** backend net shared **only with the data-proxy** (the one trusted service that needs it), and the facilitator uses **in-memory stores** (no redis), so it is not on `redisnet` either. The resource → facilitator route stays on `controlplane`; redis is on **no** resource-reachable net. The C1 sidecar split also means it is the **sidecar** (not the untrusted handler) that joins `ingress`+`controlplane`+`proxynet`; the handler joins `proxynet` only.

| Network | `internal`? | Members | Purpose |
|---|---|---|---|
| `edge` | no (external) | **traefik** only | Only network with outbound internet + published `:443`/`:80`. Wildcard TLS terminates here. |
| `ingress` | **yes** | traefik, **every sidecar** | Traefik → sidecar inbound only. No gateway → not an egress path. |
| `controlplane` | **yes** | every **sidecar**, **facilitator** | Sidecar → facilitator `/verify`+`/settle`. No internet. **No redis here** (M6 fix). |
| `utter_pairnet_<slug>` | **yes** | the pair's **handler** + its own **sidecar** | Per-resource handler-to-sidecar bridge (quick 260625-mwb, supersedes the shared `proxynet` membership below). Disjoint per slug, so cross-tenant handler-to-handler is blocked at the Docker layer. |
| `proxynet` | **yes** | **data-proxy** (static `172.30.0.10`); handlers join their per-slug pairnet instead (see above) | DEFERRED: the handler's data-plane egress to the data-proxy is not wired yet (no upstream calls today). When untrusted egress lands, attach the data-proxy to each pairnet (or inject `DATA_PROXY_URL`). No internet. |
| `upstreamnet` | no (external) | **data-proxy**, **facilitator** | The only place the proxy reaches allowlisted upstreams and the facilitator reaches Arc RPC. Resources are **never** attached here. |
| `redisnet` | **yes** | **redis**, **data-proxy** | redis backend, trusted services ONLY (M6). **No resource (handler or sidecar) is ever on it.** redis is unpublished (no host `6379`). |

Per-service membership (the whole design in one list):

- **traefik** → `edge` + `ingress`. Bridges the one internet-facing net to the internal ingress net.
- **handler-`<slug>`** (untrusted, gate-less) → `utter_pairnet_<slug>` **only** (quick 260625-mwb; was shared `proxynet`). No sibling handler shares its bridge; no facilitator route, no internet. Its data-proxy egress is a DEFERRED increment (not wired today).
- **sidecar-`<slug>`** (trusted gate) → `ingress` + `controlplane` + `utter_pairnet_<slug>` (quick 260625-mwb; DROPPED the shared `proxynet`). **Never** on `edge`, `upstreamnet`, or `redisnet`. All three are `internal:true`, so it has **zero route to the internet** at the Docker layer. It reaches its own handler by inspected IP on the shared pairnet.
- **facilitator** → `controlplane` + `upstreamnet`. In-memory stores, so **not** on `redisnet`.
- **data-proxy** → `proxynet` (static `172.30.0.10`) + `upstreamnet` + `redisnet`.
- **redis** → `redisnet` **only** (M6: never on a resource-reachable net; unpublished).

### Text diagram

```
                          INTERNET
                             |
                       [ edge ] (external)
                             |
                         +--------+
                         |TRAEFIK |  (wildcard TLS terminates here)
                         +--------+
                             |
                     [ ingress ] (internal: no gateway)
                             |
   inbound: Host(<slug>.resources.<domain>) -> http://<slug>-gate:8080
                             |
                      +--------------+                      +--------------+
              +------>|  SIDECAR     |--utter_pairnet_<slug>->| HANDLER     |
              |       |  <slug>-gate |   (per-resource,      | <slug>       |
   [ controlplane ]   | (trusted     |    internal, by IP)   | (untrusted,  |
   (internal)         |  gate)       |                       | runsc, RO,   |
              |       +--------------+                       | capdrop;     |
              v             |                                | pairnet ONLY)|
        +-------------+   [ utter_pairnet_<slug> ]           +--------------+
        | FACILITATOR |   (per-resource, internal:true)
        +-------------+
          |
          |          (the untrusted HANDLER is on NO shared net: no data-proxy hop
          |           today, and no sibling handler can address it at L3)
          |
        [ upstreamnet ]
          |
          v
       Arc RPC (chain)

The untrusted HANDLER sits on its OWN per-resource pairnet utter_pairnet_<slug>
(internal:true) ALONE - NOT on any shared proxynet - so no sibling handler can
address it at L3 (quick 260625-mwb). The trusted SIDECAR bridges
ingress+controlplane+utter_pairnet_<slug> and reaches its handler by inspected IP
on that shared pairnet (runsc has no Docker DNS). redis is on redisnet ONLY -
reachable by the data-proxy, never by any resource (M6). NOTE: the untrusted-egress
data-proxy plumbing is a FOLLOW-UP: when it lands the data-proxy attaches per-pairnet
(or DATA_PROXY_URL is injected), NOT via a shared proxynet hop.
```

### How each reachability requirement is met

- **(a) Traefik → resource by name.** Both share `ingress`. The deployer's file-provider service points the loadBalancer at `http://<slug>:8080` (`traefik-config.ts:82`, `DEFAULT_RESOURCE_PORT = 8080` at `:65`); Docker embedded DNS on `ingress` resolves `<slug>` to the container. The router rule `Host(<slug>.resources.<domain>)` (`traefik-config.ts:88`) matches after wildcard-TLS termination on `edge`. The resource is never published to the host and never joins `edge`.
- **(b) Resource → facilitator (control plane).** Both share `controlplane`. The gate middleware's `post(${facilitator}/verify|settle)` resolves `facilitator` over Docker DNS on `controlplane`. This is a **separate network from the data plane** so the gate's trusted control traffic is never subject to — or confused with — the untrusted handler's data-proxy allowlist.
- **(c) Handler data-plane egress forced through the data-proxy** — three stacked mechanisms, weakest-trust first:
  1. **Docker layer:** the only data-plane net the resource is on is `proxynet` (`internal:true`); the sole reachable host is `data-proxy`; no default gateway, so handler `fetch("https://...")` has no route. Handler code must speak to `POST /proxy` with `x-resource-token`/`x-resource-id`/`x-upstream-url` (`data-proxy/src/proxy.ts:51-55,130`).
  2. **Proxy layer:** ordered verify → allowlist → host-pin → resolved-IP-recheck → cred-inject → forward (`proxy.ts:130-310`); the proxy is the only member also on `upstreamnet`.
  3. **nftables layer (defense-in-depth):** host `DOCKER-USER`/egress-gateway `policy drop` with the single data-proxy accept (`nftables.rules.sh:51-73`) drops the packet even if a route existed.
- **(d) Facilitator → Arc RPC, resource cannot.** The facilitator is the only control-plane service on `upstreamnet`, so it reaches `ARC_RPC_URL` for the relayer pool / `/settle`. The resource is never on `upstreamnet`; combined with the nftables `ip daddr ${ARC_RPC_IP} drop` rule (`nftables.rules.sh:67`) the resource cannot reach the chain directly. This preserves SPEC §19 "no direct chain access from the sandbox" — settlement is always mediated by the trusted facilitator, never signed inside untrusted code.

### Control-plane vs data-plane egress (why two separate internal networks)

The facilitator is a **trusted control-plane peer**; the handler's arbitrary outbound is the **untrusted data plane**. Putting them on `controlplane` and `proxynet` respectively means a compromised handler cannot use the control-plane route as a general egress (the facilitator is a fixed-shape RPC peer, not a forward proxy) and cannot route control traffic through the data-proxy's allowlist (which is scoped to upstream APIs, not the chain). This separation is exactly what lets requirements (b) and (c) coexist without one weakening the other.

---

## 4. Security analysis

### 4.1 What the service profile relaxes, and why it stays safe

**Relaxation 1 — `network`: `"none"` → three internal networks.** *Safe because* all three are `internal:true` — none has a default gateway, so the relaxation grants **named-peer reachability, not internet reachability**. The property that matters ("no direct egress except the proxy") is preserved by network *membership* (the resource is simply never on `edge`/`upstreamnet`), not by `network:"none"`. Every non-negotiable isolation invariant is unchanged, and the nftables `policy drop` remains in force as a packet-layer backstop.

**Relaxation 2 — `env`: `{}` → non-secret config allowlist.** *Safe because* SBX-03's invariant is specifically "no platform env vars, wallet keys, or upstream API keys in the container" (`Utter-SPEC.md:341`). **Config identifiers are not secrets.** The relaxed env carries only public routing/identity config; it carries no token secret, no API key, no relayer/wallet key, no RPC credential. The real upstream key never enters the container — it is resolved server-side and injected only on the proxy→upstream leg (`proxy.ts:191-238`); the resource-scoped token is minted short-lived at request time, never baked into the image env. The `service-env.ts` allowlist + secret guard enforces this at build time.

Everything else (`network:"host"`, `privileged`, `capAdd`, secret env) stays forbidden for **both** profiles.

### 4.2 What is genuinely weaker than the one-shot model, and for whom it matters

Be explicit: the service profile **is** a weaker isolation posture than the one-shot profile, in two specific ways.

1. **The strongest egress mechanism (`--network=none` + veth, "no route exists") is downgraded to "internal network with no gateway."** For the one-shot profile, `firewall.ts:18-25` prefers `--network=none`+veth precisely because it is stronger than relying on a network having no gateway. The service profile must use internal networks (it needs inbound + control-plane reachability), so it leans on `internal:true` correctness plus nftables, not on the absence of any interface.
2. **The sidecar is reachable on three networks**, so a compromised *trusted sidecar* shares L3 with the facilitator and data-proxy — a lateral-movement surface the one-shot container (on `none`) does not have. The *untrusted handler* is now confined to `proxynet` alone (C1 split), so it shares L3 with only the data-proxy, not the facilitator. With the M6 fix, **no resource (handler or sidecar) shares L3 with redis at all** — redis is on `redisnet`, reachable only by the data-proxy.

**For whom this matters:**
- **The trusted ECHO resource (Phase 1):** the code inside is ours and audited. The weaker posture is acceptable because the threat is not "the handler is adversarial" but "the plumbing must work." This is why Phase 1 can ship the long-lived profile before the full topology and nftables are applied.
- **Arbitrary AI-generated resources (Phase 2+):** the code inside is adversary-controlled. Here the weaker posture is **not** acceptable on its own — it must be backed by the full four-/five-network internal topology, the applied host nftables `policy drop`, the per-resource scoped proxy token, and ideally per-resource network segmentation. The service profile is only safe for untrusted code *with the topology and nftables in place*; Phase 1's shortcuts (below) are explicitly named as not-yet-safe-for-untrusted.

### 4.3 Residual risks + mitigations

1. **Compromised resource pivots to facilitator/proxy over shared internal nets.** *Mitigation:* facilitator treats all `controlplane` input as untrusted (already authenticates payload sig + nonce + reservation, `Utter-SPEC.md:349,628`); proxy fails closed on token/allowlist/host-mismatch (`proxy.ts:140-219`). **redis is off every resource-reachable net (M6):** it is on `redisnet` with the data-proxy only, so a compromised handler (on `proxynet`) or sidecar (on `ingress`+`controlplane`+`proxynet`) has no L3 path to it - it can never reach redis directly, let alone before auth. Per-resource net segmentation (§12) eliminates resource-to-resource reachability in the multi-host future; on the single MVP host, isolation relies on each service trusting only authenticated input.

   **Sidecar split sharpens this (D6, cross-tenant FREE COMPUTE, not just probing).** The "trusting only authenticated input" assumption above held when each resource carried its OWN gate. With the C1 split, the untrusted HANDLER is gate-less and has NO auth on `/call` - so a flat shared `proxynet` is not merely a lateral-probing surface, it is a cross-tenant free-compute hole: any handler can POST a sibling handler's `/call` at L3 with no escrow reservation, charging compute against another creator. The fix is the per-pair `pairnet_<slug>` + a DOCKER-USER `proxynet` filter that allows only handler->data-proxy + a sibling-unreachability probe target (see `infrastructure/RUNBOOK.md` "Phase 2 known limitations" #1). This is the open-decision 4 / D6 per-resource segmentation, now a HIGH blocker for untrusted multi-tenant rather than a deferred nicety. SAFE for single-tenant + the trusted echo; NOT safe for untrusted multi-tenant.
2. **gVisor escape → host → bypasses the Docker-network design.** *Mitigation:* host nftables `policy drop` is namespace-independent (filters at the host output hook), so an escaped process still hits the default-drop. Keep runsc updated; nested virt is provisioned for a Firecracker upgrade path (`PROVISION.md`).
3. **DNS rebinding / SSRF through the proxy to metadata / RFC1918.** *Mitigation already present:* the proxy re-resolves and re-checks every A/AAAA against `EGRESS_BLOCK_SET` (link-local/metadata + RFC1918 + loopback) immediately before connect (CR-02, `proxy.ts:223-255`). *Residual:* the recheck does not yet socket-pin — a production pinning dispatcher closes the TOCTOU window.
4. **Internal-network gateway leak (Docker quirk).** A forgotten `internal:true` or an `enable_ipv6` v6 default route silently grants egress. *Mitigation:* `createLiveHostProbe` asserts the metadata IP, an RFC1918 host, Arc RPC, the facilitator, and host loopback are all unreachable from inside the container netns (`RUNBOOK.md:25-55`). This probe is the regression test for this exact leak and must run after any compose change.
5. **Traefik straddles trust zones (`edge` ↔ `ingress`).** A Traefik RCE bridges internet to internal nets. *Mitigation:* no dashboard/api exposed (`traefik.yml:38-39`); DNS-01 creds only in `.env.local`; Traefik is on `edge`+`ingress` only — never on `controlplane`/`proxynet`/`upstreamnet`, so a Traefik compromise still cannot reach the settle path or the proxy's upstream credentials.
6. **Idle-reaper / scale-to-zero race re-attaching a stale resource to the wrong network** (§12). *Mitigation:* the deployer re-asserts three-network membership on every (re)deploy and re-runs the probe; redeploy invalidates cache and persists slug/agentId.

### 4.4 How host nftables complements the Docker-network design

Two deliberately redundant, independent layers — neither alone is the boundary:

- **Docker internal networks = routing-layer deny.** `internal:true` removes the default gateway, so the resource has *no route* off its three nets. Primary mechanism for the long-lived profile; what makes relaxation 1 safe.
- **Host nftables = packet-layer deny, below the container.** `nftables.rules.sh` installs `type filter hook output priority 0; policy drop` with a single `data-proxy ip:port accept` and explicit drops for metadata/RFC1918/loopback/Arc-RPC/facilitator (`:51-73`). It runs **on the host, never in the container** (`firewall.ts:4-11`) precisely because untrusted root-in-container could lift an in-container rule; gated by `UTTER_SANDBOX_HOST=1` so it refuses to run on a non-boundary dev box (`:41-46`).

The block set is duplicated in TS (`firewall.ts:42-48`) and shell (`nftables.rules.sh:60-68`) so each is independently unit-assertable and operator-appliable. Net: a resource would have to simultaneously (i) find a missing `internal:true` flag or a gVisor escape, **and** (ii) defeat the host `policy drop`, **and** (iii) get past the proxy's token+allowlist+host-pin+IP-recheck — three independent layers, none "plain Docker."

---

## 5. On-chain registration + studio integration

### 5.1 The registration step (why it is required)

`PaymentEscrow.debit` calls `registry.getResource(resourceId)` and reverts `ResourceInactive` when `!active` (`PaymentEscrow.sol:178-179`); `ResourceRegistry.getResource` reverts `UnknownResource` for a never-registered id (`ResourceRegistry.sol:178-186`). The `resourceId` that reaches `debit` is the keccak label the gate advertises as `payTo` (`inject-x402.ts:97`, `echo/main.ts:120`; the wallet signs `quote.payTo` at `usePayPerCall.ts:193`; the facilitator requires `authorization.resourceId === requirements.resourceId` at `verify.ts:182` and passes it straight into `debit` at `settle.ts:351-358`).

So **`debit` reverts unless that exact keccak id is registered + active.** Today nothing in the deployer writes the registry — the 2026-06-20 proof did it by hand (`DEPLOYMENTS.md:35`).

**Confirmed signature** (verified against source): `register(bytes32 resourceId, address creator, address treasury, uint16 creatorBps, bytes32 agentId, bytes32 pricingHash)` is `onlyOwner`, reverts `AlreadyRegistered` if taken, and always stores `active: true` (`ResourceRegistry.sol:88-112`). There is **no `active` parameter**; idempotency is driven by the registry's own `isActive(resourceId)` read (`:189-192`).

### 5.2 New module: `services/deployer/src/register-resource.ts`

Mirrors the proven admin-signed registry-write pattern in `packages/staking/src/slash.ts`: inject an admin writer + reader, never read a key itself, so it is unit-testable with a spy.

- `RegistryAdminWriter` — `{ writeContract({ address, abi, functionName, args }): Promise<Hex> }`.
- `RegistryReader` — `{ readContract(...): Promise<boolean> }` for `isActive`; optional `waitForTransactionReceipt`.
- `registerResourceIfNeeded(deps, params)`:
  1. **Idempotency read first:** if a reader is provided, call `isActive(resourceId)`; if `true`, return `{ registered:false, alreadyActive:true }` and emit no tx. Covers redeploys of the same label without a second register and without needing `getResource` (which reverts on unknown).
  2. **Validate before write:** reject zero `creator`/`treasury` and `creatorBps > 10000` (mirror the contract's `ZeroAddress`/`InvalidBps`) so bad config fails locally.
  3. **Write:** `register` with `agentId`/`pricingHash` defaulting to `ZERO32` (advisory indexer fields, not read by `debit`); await receipt when available.
  4. **Race safety:** if the write reverts `AlreadyRegistered`, treat as idempotent success; surface a registered-but-*paused* id as a distinct result so the deployer logs it rather than silently unpausing.

Imports `RESOURCE_REGISTRY` + `registryAbi` from `@utter/chain`. No env/key read lives here.

### 5.3 Wiring into `live-deploy.ts`

Add the registration step **before the unpaid 402 call** (currently `live-deploy.ts:170-171`), so the resource is active before any debit can fire.

- imports: add `RESOURCE_REGISTRY`, `registryAbi`, and `registerResourceIfNeeded`.
- operator inputs (`:133-140`): read from `.env.local` — `REGISTRY_ADMIN_PRIVATE_KEY` (the registry owner; build an admin wallet via `createArcWalletClient(privateKeyToAccount(adminKey), rpcUrl)`), `PLATFORM_TREASURY`, `creatorBps = 10000 - PLATFORM_FEE_BPS` (= 7000 by default, matching the proven 70/30 split), `creator = RESOURCE_CREATOR ?? adminAccount.address`.
- new step: `await registerResourceIfNeeded({ admin, publicClient }, { resourceId: RESOURCE_ID, creator, treasury, creatorBps })` where `RESOURCE_ID` is the **same keccak id the quote advertises** (`live-deploy.ts:63`).
- `LiveDeployResult`: add `registrationTx?: Hex` and `alreadyActive: boolean`.
- barrel: export `registerResourceIfNeeded` from `services/deployer/src/index.ts`.
- `.env.example`: `REGISTRY_ADMIN_PRIVATE_KEY`/`PLATFORM_TREASURY`/`PLATFORM_FEE_BPS` already exist; add a note that the deployer now consumes them, plus an optional `RESOURCE_CREATOR=`.

Money discipline: `creatorBps` is a `uint16` ratio (0-10000), never an amount; the helper does no USDC math (the split stays on-chain in `PaymentEscrow.debit`); keys are read only in `live-deploy.ts` and passed into the injected wallet.

### 5.4 Studio integration (studio-initiated paid call)

Three confirmed gaps and their fixes:

- **(a) Real `cardUrl` from `DEPLOY_DOMAIN`.** Both the seed (`live-deps.server.ts:122`) and `createResource` (`live.ts:232`) hardcode `https://<slug>.resources.example.com/...`, and the studio derives the live POST origin from it. Add a `resolveCardUrl(slug, env)` helper reading `DEPLOY_DOMAIN`, computing `apex = resources.<domain>` (guard against a double `resources.` prefix since `.env.example` already has `resources.example.com`), returning `https://<slug>.<apex>/.well-known/agent-card.json`, with the `example.com` literal kept as an explicit local-dev fallback. Thread `env` into `getSharedIndexStore`/`seedRecords`; inject a `deployDomain`/`buildCardUrl(slug)` field onto `LiveDeps` so `live.ts` stays free of `process.env`.
- **(b) Canonical keccak resourceId as payTo.** Replace the sha256 `deriveLocalResourceId` (`live.ts:88-96`) with `keccak256(toHex(label))` over the **same label scheme the deployer registers**. Drop `localResourceCounter` (a keccak of a stable label is deterministic by design). In `recordToDetail`, set the served card's `payTo`/`payout` to the bytes32 `resourceId` (it is the escrow target the wallet signs). Keep `creator` a real owner address — the registry stores `creator` and `resourceId` separately.
  - *Nuance to document:* the live paid call does **not** depend on the studio's `payTo`. In live mode the submitter POSTs to the deployed resource, whose own 402 carries the authoritative keccak `payTo` (`main.ts:120`), and `usePayPerCall` signs *that* quote. Making the studio id canonical is what guarantees `/resources/<id>` resolves the right resource and the displayed/escrow ids agree.
- **(c) Live submitter POSTs the resource's `/call`.** Largely already done: `liveSubmitPayment` defaults to `DEFAULT_RUN_PATH = "/call"` (`submit-payment.ts:36,124`) and the echo serves `/call` behind the gate (`main.ts:159-160`). Once (a) makes `resourceUrl` real (stripped from `detail.cardUrl`, `resources.$id.tsx:184-186`), `selectSubmitPayment` selects the real transport instead of the fail-loud stub. No path change needed.

### 5.5 The load-bearing cross-piece invariant

The deployer's `RESOURCE_LABEL` → `keccak256` → registered id **must equal** the studio's `keccak256(label)` resourceId **and** the deployed resource's `RESOURCE_ID` env (`main.ts:73`). All three must derive the keccak from **one shared `resourceIdForLabel(label)` helper and one agreed label scheme** (recommend it in `@utter/x402-arc` or a small shared util, imported by `live.ts` and `live-deploy.ts`). Otherwise the studio shows/targets one id, the resource advertises a second, and the registry has a third — and `debit` reverts `ResourceInactive` or studio links 404. **This shared helper is the single most important new artifact and must be specified before any per-file edits.**

---

## 6. Phased implementation plan

Each phase lists concrete code changes (files), operator steps, and host verification. A phase does not start until the prior phase's acceptance passes (GSD, CLAUDE.md).

### Phase 1 — trusted ECHO live (smallest path to real 402 → 200 + on-chain settle)

**Goal:** one trusted echo resource, deployed as a long-lived container, reached over Traefik, serving a real 402 → 200 with an on-chain escrow settle. The threat here is "the plumbing must work," not "the handler is adversarial" — so isolation shortcuts are acceptable and named.

**Code changes:**
- Add the service profile minimum: `ResourceServiceSpec` + `ServiceHandle` + `service-env.ts` + `service-runspec.ts` + `service-dockerode-spec.ts` + `GvisorRunner.startService` (and `docker-dev.startService` for local). Export `hardenTmpfs`/`DEFAULT_TMPFS`.
- Implement the reconcile `launchContainer` hook body as: build image (reuse `buildResourceImage`/`bundleEcho`) → `buildResourceServiceSpec` → `startService` → **write the Traefik file** (new atomic temp+rename writer to `infrastructure/traefik/dynamic/<slug>.yml` using `buildTraefikDynamicConfig`) → set the resourceId launch **label** (so `listContainers` can map it back, `reconcile.ts:23-30`). Implement `reapContainer` as `stop`+remove+delete-Traefik-file. Wire `listContainers` to dockerode.
- Add `register-resource.ts` and wire `registerResourceIfNeeded` into `live-deploy.ts` (§5.3).
- Add the shared `resourceIdForLabel(label)` helper (§5.5).

**Named acceptable shortcuts (trusted echo only):**
- Run on a **single internal app network** (not yet the full five-network split) — acceptable because the echo code is ours; not safe for untrusted code.
- nftables may be **not yet applied** on the dev/WSL2 box; the egress firewall stays rule-generation-only here.
- In-memory `DeploymentStore` (resets on restart) is fine for one resource.
- `docker-dev` (runc) backend is acceptable for local wiring proof; the **on-chain settle** part still runs against Arc Testnet.

**Operator steps:**
- Provide `.env.local`: `REGISTRY_ADMIN_PRIVATE_KEY` (funded testnet owner), `PLATFORM_TREASURY`, `PLATFORM_FEE_BPS`, `ARC_RPC_URL`, `DEPLOY_DOMAIN`.
- Run the deploy entry (`live-deploy.ts`) — it registers the resource, builds + starts the echo container, writes the Traefik file.

**Host verification:**
- `isActive(RESOURCE_ID) == true` after the registration step (and idempotent on re-run).
- Traefik serves `https://<slug>.resources.<domain>/call`; an unpaid call returns 402 with `payTo == RESOURCE_ID`.
- A paid call returns 200 and an on-chain `debit` lands with the 70/30 split (the existing money-path E2E + `DEPLOYMENTS.md` proof).

### Phase 2 — harden for arbitrary UNTRUSTED resources (full topology)

**Goal:** the same deploy path is now safe for adversary-controlled AI-generated code. This is where the weaker-than-one-shot posture (§4.2) is made acceptable for untrusted code.

**Code changes:**
- Per-deploy **scoped proxy token mint** (`mintResourceToken(resourceId,...)`, `token.ts:21`) + inject via the resource's request-time path (never static env).
- Replace the data-proxy dev credential fixture with a secrets-backed `CredentialResolver` (`credentials.ts:59`) and a **per-resource allowlist** (`DataProxyOpts.allowlist`, `proxy.ts:75`).
- Real base-image digests in `build.ts:31-34` (currently placeholder zero-digests) + `REGISTRY_MIRROR_URL`.
- `service-runspec.test.ts` / `service-env.test.ts` invariant + guard tests proving the service profile keeps every isolation flag and rejects secret env.
- Swap the in-memory store for a persistent (Redis/pg) `DeploymentStore`.

**Operator steps:**
- Stand up the **five-network compose** (`edge`/`ingress`/`controlplane`/`proxynet`/`upstreamnet` with the exact `internal:true` flags) on the provisioned gVisor host.
- Apply the host **nftables ruleset** (`nftables.rules.sh`, `UTTER_SANDBOX_HOST=1`).
- Provision the **wildcard DNS-01 cert** (`*.resources.<domain>`) and DNS-01 creds in `.env.local`.
- Confirm runsc is the active runtime and nested virt is available.

**Host verification:**
- `createLiveHostProbe` passes: from inside a resource container, the metadata IP, an RFC1918 host, Arc RPC, the facilitator, and host loopback are all **unreachable** (`RUNBOOK.md:25-55`) — the regression test for the internal-network leak (residual risk 4).
- Egress/secret/limit probes pass: handler `fetch` to a non-allowlisted host is blocked; no platform env/secret is present in the container; pids/mem/cpu/timeout caps hold.
- The service-profile invariant tests pass (runsc, RO rootfs, capDrop ALL, no capAdd, no `timeoutSeconds` field, network ∈ the three internal nets).

### Phase 3 — studio-initiated end-to-end

**Goal:** a creator deploys from the studio and an agent (or the studio wallet) pays the live resource per call, end-to-end.

**Code changes:**
- `live-deps.server.ts`: `resolveCardUrl` + `deployDomain`/`buildCardUrl`; thread `env` into `getSharedIndexStore`/`seedRecords` (§5.4a).
- `live.ts`: keccak `resourceId` via the shared helper; real `cardUrl` via injected domain; `recordToDetail` `payTo`/`payout` = canonical bytes32; keep `creator` an address (§5.4b).
- `submit-payment.ts`: no change (already `/call`); confirm `selectSubmitPayment` now selects the real live transport.
- Start the reconcile loop in `services/deployer/src/server.ts` (currently deliberately not started) with the Phase 1/2 `launchContainer`/`reapContainer` hooks.

**Operator steps:**
- Set `STUDIO_DATA_ADAPTER=live` and `DEPLOY_DOMAIN` for the studio.
- Ensure the studio's label scheme matches the deployer's `RESOURCE_LABEL` (the shared helper guarantees this; verify config).

**Host verification:**
- Create a resource in the studio → it appears at `/resources/<keccak-id>` with `payTo == RESOURCE_ID`.
- The studio's live submitter POSTs `https://<slug>.resources.<domain>/call`, gets a 402, signs the resource's own quote, and the call returns 200 with an on-chain settle.
- The cross-piece invariant holds: studio id == deployer-registered id == resource `RESOURCE_ID` env (§5.5).

---

## 7. Open decisions for the operator

These need a human call before or during implementation:

1. **Containerize the facilitator (and redis) — yes/no.** The topology assumes the facilitator runs as a container on `controlplane`+`upstreamnet` and redis on `redisnet` (M6: never on a resource-reachable net). If the facilitator stays a host process, the resource → facilitator route and the `ip daddr ${facilitator} drop` nftables rule must be re-expressed against the host IP, and the control-plane "internal network" property weakens. Recommendation: containerize for Phase 2 so the internal-network guarantee is uniform.
2. **Internal-networks vs nftables-only for egress containment.** This design uses both (defense-in-depth). The operator may decide whether the single MVP host runs both from the start (recommended for untrusted Phase 2) or relies on internal networks alone for Phase 1 (acceptable for trusted echo). Do not run untrusted resources with only one layer.
3. **Restart policy default.** This design proposes `unless-stopped`. Alternatives: `on-failure` with a max-retry cap (avoids restart-loop resource burn on a crashing handler) — relevant for untrusted code that may crash repeatedly. Operator picks the policy and any backoff.
4. **Per-resource network segmentation vs shared internal nets on the single host. RESOLVED (quick 260625-mwb).** The MVP previously shared `proxynet` across all handlers, which let a sibling handler reach another tenant's gate-less handler at L3 (cross-tenant free compute, RUNBOOK #1). RESOLUTION: each pair now gets a dedicated internal bridge `utter_pairnet_<slug>` (`Internal: true`); the handler joins ONLY its pairnet (no shared proxynet), the sidecar joins `ingress`+`controlplane`+its pairnet (also dropping proxynet) and reaches its handler by inspected IP. Cross-tenant handler-to-handler is blocked at the Docker layer by disjoint internal bridges. RATIONALE for choosing the Docker-layer disjoint-pairnet design over the nftables-FORWARD-dependent alternative: the handler->data-proxy egress path is not wired yet (the echo makes no upstream calls), so nothing depends on a shared proxynet today, and the host nftables ruleset is `hook output` (host egress) which does not filter intra-bridge sibling forwarding anyway. The disjoint pairnet is therefore the SOLE and sufficient enforcement of handler-sibling isolation now; when untrusted egress lands, attach the data-proxy per pairnet (or inject `DATA_PROXY_URL`). Lifecycle: pairnet reaped on the last slug container + an orphan-network GC sweep so no host bridge leaks.
5. **Deployment store backend.** In-memory (Phase 1, resets on restart) vs Redis/pg (Phase 2+, survives restart, required for the reconcile loop to relaunch desired records after a host reboot). Operator picks the store and its persistence guarantees.
6. **`creator` identity on testnet.** `DEPLOYMENTS.md` collapses creator/admin/treasury roles on testnet. Operator decides whether to keep the collapsed single-key model for the MVP or split `RESOURCE_CREATOR` from `REGISTRY_ADMIN_PRIVATE_KEY` now (the wiring already supports the override).
7. **Socket-pinning dispatcher for the data-proxy (residual risk 3).** The proxy re-resolves and re-checks before connect but does not yet pin the resolved IP to the socket, leaving a narrow TOCTOU window. Operator decides whether a pinning dispatcher is in scope for Phase 2 or accepted as a tracked residual.

---

### Key files (all absolute)
- `C:\Users\woshv\Desktop\utter\services\sandbox\src\runner\runspec.ts` — one-shot invariants (`network:"none"` :107, `env:{}` :122); export `hardenTmpfs`/`DEFAULT_TMPFS`.
- `C:\Users\woshv\Desktop\utter\services\sandbox\src\runner\types.ts` — `RunSpec` (:34-86, untouched); add `ResourceServiceSpec`/`ServiceHandle`/`ServiceRestartPolicy`, `RunError.phase += "start-service"`, optional `startService?`.
- `C:\Users\woshv\Desktop\utter\services\sandbox\src\runner\gvisor.ts` — add detached `startService`; `run`/`stop`/`logs`/`inspect` reused.
- `C:\Users\woshv\Desktop\utter\services\sandbox\src\egress\firewall.ts` — `EGRESS_BLOCK_SET` (:42-48) + host ruleset generator (:86-122); netns-none-veth vs internal-net mechanisms (:18-25).
- `C:\Users\woshv\Desktop\utter\infrastructure\sandbox-host\nftables.rules.sh` — host `policy drop` + single proxy accept (:51-73); host-only guard (:41-46).
- `C:\Users\woshv\Desktop\utter\packages\data-proxy\src\proxy.ts` — ordered egress flow + server-side cred injection (:130-310); token mint at `token.ts:21`.
- `C:\Users\woshv\Desktop\utter\services\deployer\src\traefik-config.ts` — `http://<slug>:8080` loadBalancer (:82) + `Host(<slug>.resources.<domain>)` router (:88); add the file writer.
- `C:\Users\woshv\Desktop\utter\services\deployer\src\reconcile.ts` — pure diff + loop; implement `launchContainer`/`reapContainer` hooks (:94-100), wire `listContainers` (resourceId label :23-30).
- `C:\Users\woshv\Desktop\utter\services\deployer\src\live-deploy.ts` — operator entry; add the registration step before the unpaid 402 (:170-171).
- `C:\Users\woshv\Desktop\utter\services\deployer\src\register-resource.ts` — NEW; mirrors `packages\staking\src\slash.ts`.
- `C:\Users\woshv\Desktop\utter\contracts\src\ResourceRegistry.sol` — 6-arg `register` (:88-112), `isActive` (:189-192); `PaymentEscrow.sol:178-179` `ResourceInactive` revert.
- `C:\Users\woshv\Desktop\utter\apps\studio\app\adapter\live-deps.server.ts` / `live.ts` — `resolveCardUrl`, keccak resourceId, canonical `payTo`.
- `C:\Users\woshv\Desktop\utter\apps\studio\app\wallet\submit-payment.ts` (:36,:124) / `usePayPerCall.ts` (:193) — live `/call` transport, signs `quote.payTo`.
- `C:\Users\woshv\Desktop\utter\infrastructure\docker-compose.yml` — current single-network dev stack; target is the five-network layout in §3.
- `C:\Users\woshv\Desktop\utter\Utter-SPEC.md` — §9.3, §9.5 (336-346), §12 (496-500), §19 (627-640).
