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
# The ruleset mirrors services/sandbox/src/egress/firewall.ts (buildEgressRuleset
# + EGRESS_BLOCK_SET): default policy DROP; the ONLY accept is the data-proxy
# ip:port; every block-set destination (link-local/metadata, RFC1918, host
# loopback, the Arc RPC, the facilitator) is dropped explicitly AND by the
# catch-all default policy. The dynamic blocked-host probe (createLiveHostProbe)
# asserts every one of these is unreachable from inside the container netns
# (SBX-02/06).
#
# Mechanism: this is the Mechanism B (DOCKER-USER REJECT, defense-in-depth)
# expression. The primary prod mechanism is `--network=none` + a veth to the
# egress gateway (so NO route exists except the proxy); these explicit drops are
# the belt-and-braces denylist on top of that.
#
# Usage (operator, on the provisioned host):
#   DATA_PROXY_IP=10.200.0.2 DATA_PROXY_PORT=8080 \
#   ARC_RPC_IP=<resolved> FACILITATOR_IP=<resolved> \
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

    # The ONLY allowed egress: the data-proxy ip:port (the single permitted route).
    ip daddr ${DATA_PROXY_IP} tcp dport ${DATA_PROXY_PORT} accept

    # --- EGRESS_BLOCK_SET (mirrors services/sandbox/src/egress/firewall.ts) ---
    ip daddr 169.254.0.0/16 drop      # link-local + cloud metadata (169.254.169.254)
    ip daddr 10.0.0.0/8     drop      # RFC1918 private
    ip daddr 172.16.0.0/12  drop      # RFC1918 private
    ip daddr 192.168.0.0/16 drop      # RFC1918 private
    ip daddr 127.0.0.0/8    drop      # host loopback

    # --- Per-deploy infra IPs (resolved at deploy; defense-in-depth) ---
    ip daddr ${ARC_RPC_IP}     drop   # Arc RPC (no direct chain access from the sandbox)
    ip daddr ${FACILITATOR_IP} drop   # facilitator (no direct settle access from the sandbox)

    # everything else -> policy drop
  }
}
NFT

echo "[nftables.rules.sh] applied host-side default-deny egress (policy drop;"
echo "  only ${DATA_PROXY_IP}:${DATA_PROXY_PORT} accepted). Verify with the dynamic"
echo "  blocked-host probe (createLiveHostProbe) per infrastructure/RUNBOOK.md."
