// firewall.test.ts - the egress ruleset GENERATOR is default-deny, only-proxy
// (SBX-02 / PRX-02). Pure assertions on the generated ruleset; nothing applied.
import { describe, expect, it } from "vitest";
import {
  EGRESS_BLOCK_SET,
  buildEgressRuleset,
  type EgressRuleset,
} from "../src/egress/firewall";

const OPTS = {
  dataProxyIp: "10.88.0.2",
  dataProxyPort: 8080,
  arcRpcIp: "203.0.113.50",
  facilitatorIp: "203.0.113.60",
} as const;

const rs: EgressRuleset = buildEgressRuleset(OPTS);

describe("firewall - default-deny, only-proxy", () => {
  it("default policy is drop", () => {
    expect(rs.policy).toBe("drop");
    expect(rs.nftables).toContain("policy drop;");
  });

  it("the ONLY accept is the data-proxy ip:port", () => {
    expect(rs.accept).toEqual({ ip: OPTS.dataProxyIp, port: OPTS.dataProxyPort });
    expect(rs.nftables).toContain(
      `ip daddr ${OPTS.dataProxyIp} tcp dport ${OPTS.dataProxyPort} accept`,
    );
    // Exactly one accept rule in the generated text.
    const acceptCount = (rs.nftables.match(/ accept/g) ?? []).length;
    expect(acceptCount).toBe(1);
  });

  it("has NO accept rule for any non-proxy destination", () => {
    for (const drop of rs.drops) {
      // No accept anywhere on a dropped destination's line.
      const line = rs.nftables.split("\n").find((l) => l.includes(drop.cidr));
      expect(line).toBeDefined();
      expect(line).not.toContain("accept");
    }
  });
});

describe("firewall - the block set", () => {
  it("blocks 169.254.0.0/16 (link-local + metadata 169.254.169.254)", () => {
    expect(rs.drops.some((d) => d.cidr === "169.254.0.0/16")).toBe(true);
    expect(rs.nftables).toContain("ip daddr 169.254.0.0/16 drop");
  });

  it("blocks all three RFC1918 ranges", () => {
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) {
      expect(rs.drops.some((d) => d.cidr === cidr)).toBe(true);
      expect(rs.nftables).toContain(`ip daddr ${cidr} drop`);
    }
  });

  it("blocks host loopback 127.0.0.0/8", () => {
    expect(rs.drops.some((d) => d.cidr === "127.0.0.0/8")).toBe(true);
  });

  it("blocks the Arc RPC and the facilitator", () => {
    expect(rs.drops.some((d) => d.cidr === OPTS.arcRpcIp)).toBe(true);
    expect(rs.drops.some((d) => d.cidr === OPTS.facilitatorIp)).toBe(true);
    expect(rs.nftables).toContain(`ip daddr ${OPTS.arcRpcIp} drop`);
    expect(rs.nftables).toContain(`ip daddr ${OPTS.facilitatorIp} drop`);
  });

  it("EGRESS_BLOCK_SET enumerates every static blocked CIDR (independently assertable)", () => {
    const cidrs = EGRESS_BLOCK_SET.map((e) => e.cidr);
    expect(cidrs).toEqual([
      "169.254.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "127.0.0.0/8",
    ]);
  });
});

describe("firewall - host-side mechanism choice", () => {
  it("defaults to Mechanism A (--network=none + veth egress gateway)", () => {
    expect(rs.mechanism).toBe("netns-none-veth");
  });

  it("exposes Mechanism B (internal-net + DOCKER-USER) behind the same interface", () => {
    const b = buildEgressRuleset({ ...OPTS, mechanism: "internal-net-docker-user" });
    expect(b.mechanism).toBe("internal-net-docker-user");
    // Same default-deny + only-proxy guarantees regardless of mechanism.
    expect(b.policy).toBe("drop");
    expect(b.accept).toEqual({ ip: OPTS.dataProxyIp, port: OPTS.dataProxyPort });
  });

  it("the generated rule is host-side (never an in-container rule)", () => {
    expect(rs.nftables).toContain("DO NOT apply inside the container");
  });
});
