#!/usr/bin/env bash
#
# nftables.rules.sh - a MINIMAL host-output egress denylist for the sandbox host.
#
# !!! THIS RUNS ON THE HOST, NEVER INSIDE THE UNTRUSTED CONTAINER !!!
# This is belt-and-braces for the HOST ITSELF. It is explicitly NOT the container
# containment boundary. The chain below is policy ACCEPT with a couple of host-only
# drops; it must never lock the operator out and never break host->container traffic.
# It is applied by the OPERATOR on the provisioned gVisor host as part of
# infrastructure/RUNBOOK.md; it is NOT run in the autonomous suite and NOT run on
# the builder's Docker Desktop box (which is not a security boundary).
#
# WHAT ENFORCES CONTAINER CONTAINMENT (not this chain):
# The container boundary is the per-resource internal:true pairnet topology. The
# untrusted handler joins ONLY its own utter_pairnet_<slug> bridge (Internal: true,
# no gateway), so it has no route off-host at the Docker layer and no sibling
# handler shares its bridge. That topology is already proven live (PRX-02). The
# container's ALLOWED egress (when it has any) is governed by the data-proxy egress
# firewall (services/sandbox/src/egress/firewall.ts), not by host nftables.
#
# WHY POLICY IS ACCEPT, NOT DROP:
# A default-drop host-output chain has two fatal problems on a real host.
# (1) It locks the operator out: when the chain loads, the operator's in-flight SSH
#     session has no conntrack established entry yet on the new table, so the SSH
#     reply packets are dropped mid-session and recovery needs the provider serial
#     console. (2) It breaks legitimate host egress AND host->container traffic: a
#     host-output chain sees the HOST's own packets, including host->container hops
#     on the Docker 172.x bridges (deployer->facilitator) and host loopback. The
#     RFC1918, loopback, and facilitator drops were therefore removed: on a
#     host-output chain they break host->container and loopback while never touching
#     the container's FORWARDED egress. Policy accept plus a few host-only drops is
#     the safe, honest shape.
#
# PROPER FIX / TODO (needs host validation): to actually filter the CONTAINER's
# egress at the packet layer, mirror the EGRESS_BLOCK_SET on the FORWARD path - the
# DOCKER-USER chain (iptables-nft) or an nftables `type filter hook forward` chain
# that matches the handler's bridge interface. That rewrite MUST be validated on the
# provisioned gVisor host against Docker's own nftables integration (Docker installs
# its own forward/DOCKER-USER rules, and ordering plus the bridge iifname/oifname
# matchers have to be confirmed live). Do NOT assume the forward-path rewrite works
# from inspection; it is a host-gated follow-up and is NOT part of this script.
#
# Usage (operator, on the provisioned host):
#   # ARC_RPC_IP resolves the Arc RPC host so the HOST itself does not reach it
#   # directly (the facilitator CONTAINER reaches Arc RPC via forwarded traffic and
#   # is unaffected). Resolve it at deploy:
#   ARC_RPC_IP=$(getent hosts rpc.testnet.arc.network | awk '{print $1}') \
#     UTTER_SANDBOX_HOST=1 sudo -E bash infrastructure/sandbox-host/nftables.rules.sh
#
# Verify containment with the dynamic blocked-host probe (createLiveHostProbe): that
# probe runs CONTAINER-SIDE on the pairnet and is the real containment assertion.
# This host chain is not the boundary, so do not read its presence as the proof.
set -euo pipefail

# --- Required, operator-supplied (resolve the Arc RPC at deploy) ---
ARC_RPC_IP="${ARC_RPC_IP:?set ARC_RPC_IP - resolve via: getent hosts rpc.testnet.arc.network | awk '{print \$1}'}"

# Refuse to run on a host that is not the provisioned isolation host. The operator
# sets UTTER_SANDBOX_HOST=1 in the host's environment per PROVISION.md; this guard
# stops the script being run by mistake on a dev box (which is NOT a boundary).
if [[ "${UTTER_SANDBOX_HOST:-0}" != "1" ]]; then
  echo "REFUSING: this is a HOST firewall script. Set UTTER_SANDBOX_HOST=1 on the" >&2
  echo "provisioned gVisor host (infrastructure/sandbox-host/PROVISION.md) to apply it." >&2
  echo "Plain Docker / Docker Desktop is NOT a security boundary (CLAUDE.md, SPEC 9.5)." >&2
  exit 1
fi

# Flush and (re)install the minimal host-output denylist. policy ACCEPT so it can
# never lock the operator out and never break host->container or loopback traffic.
nft -f - <<NFT
table inet utter_egress {
  chain egress {
    type filter hook output priority 0; policy accept;

    # --- HOST SELF-PRESERVATION (kept defensively even under policy accept) ---
    # These accepts make a future flip back to policy drop unable to silently lock
    # the operator out. They are harmless under policy accept.
    # ct state established,related accept: keep already-established connections alive
    # (the operator's inbound SSH session's reply packets are established-state).
    ct state established,related accept
    # tcp sport 22 accept: the SSH server's own replies, conntrack-independent, so
    # the operator is never dropped even on a fresh table with no conntrack entry.
    tcp sport 22 accept
    # oifname "lo" accept: host loopback - systemd-resolved DNS at 127.0.0.53 and
    # the Docker API socket and other host-local daemons.
    oifname "lo" accept

    # --- HOST-ONLY DENYLIST (destinations the HOST must never reach directly, and
    # that do NOT break host->container or legitimate host egress) ---
    ip daddr 169.254.0.0/16 drop      # link-local + cloud metadata (169.254.169.254)
    ip daddr ${ARC_RPC_IP}  drop      # Arc RPC: the facilitator CONTAINER reaches it
                                      # via forwarded traffic and is unaffected; the
                                      # host itself has no business reaching it.

    # Everything else falls through to policy accept. The host needs DNS, apt,
    # registry pulls, NTP, and host->container traffic on the Docker 172.x nets
    # (deployer->facilitator), so it must not be dropped here.
  }
}
NFT

echo "[nftables.rules.sh] applied the minimal host-output denylist (policy accept;"
echo "  host self-preservation accepts plus drops for 169.254.0.0/16 and the Arc RPC"
echo "  ${ARC_RPC_IP}). This is host-only belt-and-braces, NOT the container boundary."
echo "  Verify containment with the container-side blocked-host probe (createLiveHostProbe)"
echo "  on the pairnet per infrastructure/RUNBOOK.md."
