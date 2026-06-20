# PROVISION - the operator-provisioned gVisor isolation host

> **The only trusted isolation boundary is gVisor (runsc) on this provisioned
> host. Plain Docker / Docker Desktop (the `docker-dev` runner backend) is NOT a
> security boundary** (CLAUDE.md, SPEC 9.5). `docker-dev` exists for wiring and
> integration tests only. The runsc-under-WSL2 spike (Plan 01, recorded in
> `infrastructure/sandbox-host/README.md`) confirmed runsc is NOT runnable on the
> builder's Docker Desktop host, so the live security acceptance is operator-gated
> regardless and runs ONLY on this provisioned host.

This document is the step-by-step provisioning runbook for the Linux isolation
host that enforces the Phase 3 security boundary. Provision in this order:

1. the gVisor host (runsc + nested virt + a quota-capable storage driver),
2. the host egress firewall (`nftables.rules.sh`),
3. the internal Verdaccio build mirror,
4. the `*.resources.<domain>` wildcard TLS / DNS-01.

Then run the three live acceptances per `infrastructure/RUNBOOK.md`.

---

## 1. Provision a Linux host with nested virt

- A Linux VM/host with **nested virtualization** enabled (so a stronger
  Firecracker upgrade is possible later; gVisor's default `systrap` platform
  needs no `/dev/kvm`, but provision nested virt now to avoid a re-host).
- Docker Engine installed (`dockerd`), NOT Docker Desktop. Docker Desktop's
  managed WSL2 kernel cannot register runsc (the Plan 01 spike result).
- Set `UTTER_SANDBOX_HOST=1` in the host environment so `nftables.rules.sh`
  recognizes this as the provisioned boundary.

## 2. Install runsc and register the runtime

Install gVisor and register it as a Docker runtime. `runsc install` writes a
`runtimes` entry to `/etc/docker/daemon.json` (RESEARCH Code Ex 2):

```jsonc
// /etc/docker/daemon.json - written by `runsc install`, then restart dockerd.
{ "runtimes": { "runsc": { "path": "/usr/local/bin/runsc", "runtimeArgs": [] } } }
```

```bash
runsc install
systemctl restart docker

# Smoke: confirm the runsc runtime is registered and runs (systrap platform,
# no /dev/kvm needed - the recommended in-VM platform since mid-2023).
docker run --rm --runtime=runsc --platform=systrap hello-world
```

If the smoke fails with seccomp `SECCOMP_RET_TRAP`, a blocked `CLONE_NEWUSER`, or
missing-kernel-feature errors, the host kernel is too restricted (RESEARCH
Pitfall 1) - fix the kernel/host before proceeding. **Do NOT fall back to plain
`runc` and call it the boundary.**

## 3. Confirm a quota-capable storage driver (disk quota)

`--storage-opt size=` disk-quota enforcement (SBX-04) needs a quota-capable
storage driver/FS - **overlay2 on xfs with `pquota`** (RESEARCH Pitfall 4):

```bash
docker info | grep -i 'storage driver'          # expect: overlay2
xfs_info / | grep -i 'pquota\|prjquota'          # expect the project-quota flag

# Mount the docker data dir from an xfs FS mounted with pquota, e.g. /etc/fstab:
#   /dev/sdX /var/lib/docker xfs defaults,pquota 0 0
# then confirm a quota-bounded container cannot exceed its --storage-opt size=.
docker run --rm --runtime=runsc --storage-opt size=512m busybox \
  sh -c 'dd if=/dev/zero of=/big bs=1M count=600 || echo "quota enforced (expected)"'
```

Until the host confirms the quota-capable driver/FS, memory/PID/CPU/timeout + the
HARD request/response size cap (`services/sandbox/src/runner/size-cap.ts`) are the
enforced limits; disk quota is the operator-confirmed addition.

## 4. Apply the host egress firewall

Resolve the Arc RPC + facilitator hosts to IPs at deploy time, then apply the
HOST-side default-deny ruleset (it mirrors `EGRESS_BLOCK_SET` in
`services/sandbox/src/egress/firewall.ts`):

```bash
UTTER_SANDBOX_HOST=1 DATA_PROXY_IP=<proxy-ip> DATA_PROXY_PORT=8080 \
  ARC_RPC_IP=<resolved-arc-rpc-ip> FACILITATOR_IP=<resolved-facilitator-ip> \
  sudo -E bash infrastructure/sandbox-host/nftables.rules.sh
```

The rule is applied at the host / egress-gateway netns, **never inside the
container** (RESEARCH Pitfall 2). The primary mechanism is `--network=none` + a
veth to the egress gateway (no route except the proxy); these explicit drops are
defense-in-depth.

## 5. Provision the internal Verdaccio build mirror (SBX-05)

The no-network-at-build property (SBX-05) holds ONLY behind the internal mirror.
Provision Verdaccio as a pull-through npm mirror and point the build container's
ONLY registry at it:

```bash
# infrastructure/docker-compose.yml already defines the verdaccio service.
docker compose up -d verdaccio
# Then set REGISTRY_MIRROR_URL in .env.local; the build (services/deployer/build.ts)
# installs from the mirror with --network restricted to it.
```

Do **NOT** claim the no-network-at-build property until this mirror exists -
locally the build uses the public registry with the documented swap.

## 6. Provision the wildcard TLS / DNS-01 (`*.resources.<domain>`)

The live HTTPS 402->200 deploy needs the `*.resources.<domain>` wildcard cert.
Wildcards REQUIRE DNS-01 (only DNS-01 proves control of the whole domain -
RESEARCH Pitfall 5); the Traefik `le` resolver's `dnsChallenge` is in
`infrastructure/traefik/traefik.yml`.

```bash
# 1. Create the DNS records at your provider:
#      resources.<domain>      A/AAAA -> the host
#      *.resources.<domain>    A/AAAA -> the host
# 2. Grant Traefik DNS-01 edit access (a DNS-edit-scoped API token):
#      set DNS_PROVIDER + DNS_API_TOKEN in .env.local (gitignored, never committed).
# 3. Bring up the edge; Traefik requests the wildcard cert via DNS-01:
docker compose up -d traefik
```

---

## Provisioning checklist

- [ ] Linux host + nested virt + Docker Engine (not Docker Desktop)
- [ ] `runsc install` + daemon.json runtime; `docker run --runtime=runsc --platform=systrap hello-world` green
- [ ] overlay2 + xfs `pquota` confirmed (disk quota)
- [ ] host egress firewall applied (`nftables.rules.sh`, `UTTER_SANDBOX_HOST=1`)
- [ ] Verdaccio mirror up; `REGISTRY_MIRROR_URL` set
- [ ] `*.resources.<domain>` + apex DNS records; `DNS_PROVIDER` / `DNS_API_TOKEN` in `.env.local`
- [ ] wildcard cert issued via DNS-01 (Traefik `le` resolver)

Once all are green, run the three live acceptances per `infrastructure/RUNBOOK.md`.
