# Sandbox host — operator-provisioned isolation (gVisor / runsc)

This directory documents the **operator-provisioned** Linux isolation host that
enforces the Phase 3 security boundary. Nothing here runs on the builder's
Windows 11 + WSL2 + Docker Desktop box as a trusted boundary.

> **The only trusted isolation boundary is gVisor (runsc) on this provisioned
> host.** Plain Docker / Docker Desktop (the `docker-dev` runner backend) is
> **NOT** a security boundary (CLAUDE.md, SPEC §9.5). `docker-dev` exists for
> wiring and integration tests only. The live security acceptance
> (malicious-probe-blocked DoD SBX-02/06, live HTTPS 402->200 DEP-01/02,
> read-only/quota/timeout enforced under runsc SBX-04) runs **only** against the
> `gvisor` backend on this host and is operator-gated.

## 1. Register the runsc runtime (gVisor)

`runsc install` writes a `runtimes` entry to `/etc/docker/daemon.json`, then
restart the daemon (RESEARCH Code Ex §2):

```jsonc
// /etc/docker/daemon.json
{ "runtimes": { "runsc": { "path": "/usr/local/bin/runsc", "runtimeArgs": [] } } }
```

```bash
runsc install
systemctl restart docker
docker run --rm --runtime=runsc hello-world   # smoke
```

The default platform is `systrap` (since mid-2023): it needs **no** `/dev/kvm`
and is the recommended in-VM platform. Firecracker (the documented stronger
isolation upgrade) genuinely needs nested virt (`/dev/kvm`) and stays
operator-gated.

## 2. Default-deny host egress rules (DOCKER-USER)

Block the SSRF / metadata / private / infra set at the **host** firewall, never
inside the container (untrusted root-in-container could lift an in-container
rule — RESEARCH Pitfall 2). The container's only reachable route is the
data-proxy. Default mechanism is `--network=none` + a veth to the egress
gateway (strongest "only route is the proxy"); the `DOCKER-USER` REJECT rules
below are the defense-in-depth alternative:

```nft
# nftables (generated; RESEARCH Pattern 2). policy drop; allow only the proxy.
chain egress {
  type filter hook output priority 0; policy drop;
  ip daddr <DATA_PROXY_IP> tcp dport <DATA_PROXY_PORT> accept   # the only egress
  ip daddr 169.254.0.0/16 drop      # link-local + cloud metadata (169.254.169.254)
  ip daddr 10.0.0.0/8     drop      # RFC1918
  ip daddr 172.16.0.0/12  drop      # RFC1918
  ip daddr 192.168.0.0/16 drop      # RFC1918
  ip daddr 127.0.0.0/8    drop      # host loopback
  ip daddr <ARC_RPC_IP>   drop      # Arc RPC (resolve at deploy)
  ip daddr <FACILITATOR_IP> drop    # facilitator
  # everything else -> policy drop
}
```

## 3. Hardened run-spec (every resource container)

`--runtime=runsc --network=none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m
--cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m
--cpus=0.5 --storage-opt size=512m` (RESEARCH Code Ex §1). The runner enforces
the execution timeout = `RESOURCE_TIMEOUT_SECONDS` by killing the container. The
run-spec NEVER contains `--privileged` or `--network=host` (unit-asserted).

> `--storage-opt size=` disk-quota enforcement needs a quota-capable storage
> driver/FS (overlay2 on xfs with pquota). Confirm on this host; until then
> memory/PID/CPU/timeout + the HARD request/response size cap are the enforced
> limits (RESEARCH Pitfall 4).

## 4. Internal build mirror (SBX-05)

Provision Verdaccio as a pull-through npm mirror and point the build container's
only registry at it (`REGISTRY_MIRROR_URL`), with `--network` restricted to the
mirror. **Do NOT claim the no-network-at-build property until this mirror
exists** — locally the build uses the public registry with the documented swap.
