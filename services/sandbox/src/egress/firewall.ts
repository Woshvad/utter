// buildEgressRuleset - the default-deny egress firewall ruleset GENERATOR
// (SBX-02 / PRX-02; RESEARCH Pattern 2, Code Examples §2).
//
// !!! HOST-SIDE ONLY - NEVER AN IN-CONTAINER RULE !!!
// The ruleset this module generates is applied at the HOST network namespace
// (the `--network=none` + veth egress gateway, or the host's DOCKER-USER chain),
// NEVER inside the untrusted container. Untrusted root-in-container could lift
// any in-container firewall rule; the block MUST live below the container
// (RESEARCH Pitfall 2; OWASP SSRF). This file produces the rule TEXT + a
// structured form; it does not apply anything. Live application is OPERATOR-
// GATED (Plan 06) on the provisioned host.
//
// Default policy is DROP. The ONLY accept is the data-proxy ip:port - the
// data-proxy is the single permitted egress. Everything else (cloud metadata,
// RFC1918, host loopback, the Arc RPC, the facilitator) is dropped, both by an
// explicit block-set entry AND by the catch-all default policy.

/**
 * The egress enforcement mechanism. Default (prod) is the strongest "only route
 * is the proxy": `--network=none` + a veth pair to the egress gateway, so no
 * route to anything but the proxy exists. The alternative is an internal Docker
 * network + host DOCKER-USER REJECT rules (defense-in-depth). Both are HOST-side
 * (RESEARCH Open Question 2: default Mechanism A).
 */
export type EgressMechanism = "netns-none-veth" | "internal-net-docker-user";

/** A single blocked destination: a CIDR or a resolved host IP, with why. */
export interface EgressBlockEntry {
  /** The CIDR or IP that is dropped. */
  cidr: string;
  /** Why it is blocked (audit/readability). */
  reason: string;
}

/**
 * The static, always-blocked set (the denylist, defense-in-depth on top of the
 * default-drop policy). The dynamic per-deploy entries (the Arc RPC + the
 * facilitator IPs, resolved at deploy time) are appended by `buildEgressRuleset`
 * from its options. Exported `as const` so the block set is independently
 * assertable in the unit test.
 */
export const EGRESS_BLOCK_SET = [
  { cidr: "169.254.0.0/16", reason: "link-local + cloud metadata (169.254.169.254)" },
  { cidr: "10.0.0.0/8", reason: "RFC1918 private" },
  { cidr: "172.16.0.0/12", reason: "RFC1918 private" },
  { cidr: "192.168.0.0/16", reason: "RFC1918 private" },
  { cidr: "127.0.0.0/8", reason: "host loopback" },
] as const;

/** Inputs to the ruleset generator. */
export interface BuildEgressRulesetOptions {
  /** The data-proxy IP - the ONLY accept destination. */
  dataProxyIp: string;
  /** The data-proxy TCP port - the ONLY accept port. */
  dataProxyPort: number;
  /** The Arc RPC IP to drop (resolved at deploy time). */
  arcRpcIp: string;
  /** The facilitator IP to drop (resolved at deploy time). */
  facilitatorIp: string;
  /** The enforcement mechanism (default `netns-none-veth`). */
  mechanism?: EgressMechanism;
}

/** A structured, assertable representation of the generated ruleset. */
export interface EgressRuleset {
  /** The default policy. Always "drop". */
  policy: "drop";
  /** The enforcement mechanism this ruleset targets (host-side either way). */
  mechanism: EgressMechanism;
  /** The single permitted egress (the data-proxy). */
  accept: { ip: string; port: number };
  /** Every explicitly-dropped destination (static block set + Arc RPC + facilitator). */
  drops: EgressBlockEntry[];
  /** The generated nftables ruleset text (the host-side rule). */
  nftables: string;
}

/**
 * Build the default-deny egress ruleset.
 *
 * Guarantees (asserted in firewall.test.ts): the policy is `drop`; the ONLY
 * accept is the data-proxy ip:port; the drops include every `EGRESS_BLOCK_SET`
 * CIDR plus the Arc RPC + facilitator IPs; there is NO accept rule for any
 * non-proxy destination. The output is HOST-side (never an in-container rule).
 */
export function buildEgressRuleset(opts: BuildEgressRulesetOptions): EgressRuleset {
  const mechanism: EgressMechanism = opts.mechanism ?? "netns-none-veth";

  // Static denylist (defense-in-depth) + the per-deploy infra IPs.
  const drops: EgressBlockEntry[] = [
    ...EGRESS_BLOCK_SET.map((e) => ({ cidr: e.cidr, reason: e.reason })),
    { cidr: opts.arcRpcIp, reason: "Arc RPC (no direct chain access from the sandbox)" },
    { cidr: opts.facilitatorIp, reason: "facilitator (no direct settle access from the sandbox)" },
  ];

  const dropLines = drops.map((d) => `    ip daddr ${d.cidr} drop      # ${d.reason}`).join("\n");

  // nftables output chain: default policy drop; the ONLY accept is the proxy.
  // This is the HOST-side ruleset (the egress gateway netns / DOCKER-USER), per
  // RESEARCH Code Examples §2 - never applied inside the container.
  const nftables = [
    "# GENERATED host-side egress ruleset (SBX-02). DO NOT apply inside the container.",
    `# mechanism: ${mechanism}. Live application is operator-gated (Plan 06).`,
    "table inet utter_egress {",
    "  chain egress {",
    "    type filter hook output priority 0; policy drop;",
    `    ip daddr ${opts.dataProxyIp} tcp dport ${opts.dataProxyPort} accept   # the ONLY allowed egress (data-proxy)`,
    dropLines,
    "    # everything else -> policy drop",
    "  }",
    "}",
    "",
  ].join("\n");

  return {
    policy: "drop",
    mechanism,
    accept: { ip: opts.dataProxyIp, port: opts.dataProxyPort },
    drops,
    nftables,
  };
}
