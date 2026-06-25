#!/usr/bin/env bash
#
# nftables.rules.sh - the HOST-side default-deny egress ruleset for the sandbox.
#
# !!! THIS RUNS ON THE HOST, NEVER INSIDE THE UNTRUSTED CONTAINER !!!
# Untrusted root-in-container could lift any in-container firewall rule, so the
# block MUST live below the container - at the host network namespace / the
# DOCKER-USER chain (RESEARCH Pitfall 2; OWASP SSRF Prevention Cheat Sheet). This
# script is applied by the OPERATOR on the provisioned gVisor host as part of
# infrastructure/RUNBOOK.md; it is NOT run in the autonomous suite and NOT run on
# the builder's Docker Desktop box (which is not a security boundary).
#
# SCOPE - WHAT THIS CHAIN ACTUALLY FILTERS (be honest, do not over-claim):
# The chain below is `type filter hook output`, so it filters the HOST's OWN
# egress (packets originating from the host network namespace). The untrusted
# handler container's egress is FORWARDED traffic (it crosses the host as
# forward-path packets, NOT host-output), so this chain does NOT constrain the
# handler container. The PRIMARY and SOLE enforcement of handler containment is
# the six-network internal:true topology (infrastructure/docker-compose.yml +
# the per-resource pairnet): the handler joins ONLY its internal pairnet, which
# has no gateway, so it has no route off-host at the Docker layer. These
# host-output drops are belt-and-braces for the HOST itself, not the container.
#
# PROPER FIX / TODO (needs host validation): to make this packet-layer denylist
# actually filter the CONTAINER's egress, re-scope it to the forward path - the
# `DOCKER-USER` chain (iptables-nft) or an nftables `type filter hook forward`
# chain that matches the handler's bridge interface. That rewrite MUST be
# validated on the provisioned gVisor host against Docker's own nftables
# integration (Docker installs its own forward/DOCKER-USER rules, and ordering +
# the bridge `iifname`/`oifname` matchers have to be confirmed live). Do NOT
# assume the forward-path rewrite works from inspection; it is host-gated.
#
# The block-set the chain carries mirrors services/sandbox/src/egress/firewall.ts
# (buildEgressRuleset + EGRESS_BLOCK_SET): default policy DROP; the ONLY new-flow
# accept is the data-proxy ip:port; every block-set destination (link-local/
# metadata, RFC1918, host loopback, the Arc RPC, the facilitator) is dropped
# explicitly AND by the catch-all default policy. The dynamic blocked-host probe
# (createLiveHostProbe) asserts every one of these is unreachable from inside the
# container netns (SBX-02/06) - that probe, not this host-output chain, is the
# container-side containment assertion.
#
# Mechanism: this is the Mechanism B (DOCKER-USER REJECT, defense-in-depth)
# expression. The primary prod mechanism is the six-network internal:true topology
# (infrastructure/docker-compose.yml): the handler joins its pairnet ONLY (no
# gateway), so its sole reachable peer is the data-proxy and no route to the
# internet / facilitator / Arc RPC exists at the Docker layer. These explicit
# drops are the belt-and-braces packet-layer denylist on top of that. This IS the
# C2 resolution now that the handler is off controlplane: the handler never needs
# the facilitator (the trusted sidecar does), so dropping the facilitator/Arc-RPC
# routes for resource egress is honest, not a contradiction.
#
# Usage (operator, on the provisioned host):
#   # DATA_PROXY_IP is the data-proxy's STATIC proxynet address (compose pins it to
#   # 172.30.0.10); DATA_PROXY_PORT is the data-proxy listen port (8080, see
#   # packages/data-proxy/src/server.ts DEFAULT_PORT + Dockerfile EXPOSE). The
#   # handler is attached to proxynet, so this single accept is its sole egress.
#   DATA_PROXY_IP=172.30.0.10 DATA_PROXY_PORT=8080 \
#   ARC_RPC_IP=<resolved> FACILITATOR_IP=<resolved on controlplane> \
#     sudo -E bash infrastructure/sandbox-host/nftables.rules.sh
set -euo pipefail

# --- Required, operator-supplied (resolve the Arc RPC + facilitator at deploy) ---
DATA_PROXY_IP="${DATA_PROXY_IP:?set DATA_PROXY_IP - the ONLY permitted egress}"
DATA_PROXY_PORT="${DATA_PROXY_PORT:?set DATA_PROXY_PORT - the data-proxy TCP port}"
ARC_RPC_IP="${ARC_RPC_IP:?set ARC_RPC_IP - resolve the Arc RPC host to drop it}"
FACILITATOR_IP="${FACILITATOR_IP:?set FACILITATOR_IP - resolve the facilitator host to drop it}"

# Refuse to run on a host that is not the provisioned isolation host. The operator
# sets UTTER_SANDBOX_HOST=1 in the host's environment per PROVISION.md; this guard
# stops the script being run by mistake on a dev box (which is NOT a boundary).
if [[ "${UTTER_SANDBOX_HOST:-0}" != "1" ]]; then
  echo "REFUSING: this is a HOST firewall script. Set UTTER_SANDBOX_HOST=1 on the" >&2
  echo "provisioned gVisor host (infrastructure/sandbox-host/PROVISION.md) to apply it." >&2
  echo "Plain Docker / Docker Desktop is NOT a security boundary (CLAUDE.md, SPEC 9.5)." >&2
  exit 1
fi

# Flush and (re)install the default-deny egress table. policy drop; the ONLY
# accept is the data-proxy. This is the HOST-side rule set; it is applied to the
# egress gateway netns / the host DOCKER-USER path, never inside the container.
nft -f - <<NFT
table inet utter_egress {
  chain egress {
    type filter hook output priority 0; policy drop;

    # --- HOST SELF-PRESERVATION (MUST come first) ---
    # ct state established,related accept: keep already-established connections
    # alive. The operator's inbound SSH session's reply packets are established-
    # state, so without this the very act of applying this chain on the host would
    # drop the SSH reply traffic mid-session and LOCK THE OPERATOR OUT (recovered
    # only via the provider's serial console + `nft delete table inet utter_egress`).
    ct state established,related accept
    # oifname "lo" accept: keep host loopback services working - systemd-resolved
    # DNS at 127.0.0.53, the Docker API socket, and other host-local daemons. New
    # host-initiated egress to anything but the data-proxy is still dropped: those
    # are ct state new and fall through to the explicit block-set drops / policy drop.
    oifname "lo" accept

    # The ONLY allowed NEW egress: the data-proxy ip:port (the single permitted route).
    ip daddr ${DATA_PROXY_IP} tcp dport ${DATA_PROXY_PORT} accept

    # --- EGRESS_BLOCK_SET (mirrors services/sandbox/src/egress/firewall.ts) ---
    ip daddr 169.254.0.0/16 drop      # link-local + cloud metadata (169.254.169.254)
    ip daddr 10.0.0.0/8     drop      # RFC1918 private
    ip daddr 172.16.0.0/12  drop      # RFC1918 private
    ip daddr 192.168.0.0/16 drop      # RFC1918 private
    ip daddr 127.0.0.0/8    drop      # host loopback

    # --- Per-deploy infra IPs (resolved at deploy; defense-in-depth) ---
    # The handler is on proxynet only, so it has NO Docker-layer route to either of
    # these anyway; these drops are the packet-layer backstop (C2 resolution).
    ip daddr ${ARC_RPC_IP}     drop   # Arc RPC (no direct chain access from the sandbox)
    ip daddr ${FACILITATOR_IP} drop   # facilitator (no direct settle access from the sandbox)

    # everything else -> policy drop
  }
}
NFT

echo "[nftables.rules.sh] applied host-side default-deny egress (policy drop;"
echo "  only ${DATA_PROXY_IP}:${DATA_PROXY_PORT} accepted). Verify with the dynamic"
echo "  blocked-host probe (createLiveHostProbe) per infrastructure/RUNBOOK.md."
