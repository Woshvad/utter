// probe-runbook.test.ts - asserts the operator runbook + provisioning docs + the
// host firewall script exist and reference the right things, AND that the live
// blocked-host probe stays guarded in the autonomous suite (never runs live).
//
// This is the autonomous gate for the operator-gated Plan 06: it proves the
// deliverables are present and self-consistent (the runbook references the three
// live acceptances, the firewall script carries the full block set host-side, the
// provisioning doc states the docker-dev-is-NOT-a-boundary truth) without ever
// provisioning a host or running a live probe.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EGRESS_BLOCK_SET,
  RequiresProvisionedHostError,
  ContainmentFailureError,
  SiblingUnreachabilityError,
  createOperatorGatedProbe,
  createLiveHostProbe,
  createOperatorGatedSiblingProbe,
  createLiveSiblingProbe,
  DEFAULT_PROBE_IMAGE,
  DEFAULT_PROBE_TARGETS,
} from "../src/index";
import type { RunSpec, SandboxRunner, SiblingTarget } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
// repoRoot = services/sandbox/test -> ../../.. = repo root.
const repoRoot = resolve(here, "../../..");
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8");

const RUNBOOK = read("infrastructure/RUNBOOK.md");
const PROVISION = read("infrastructure/sandbox-host/PROVISION.md");
const NFTABLES = read("infrastructure/sandbox-host/nftables.rules.sh");

describe("probe-runbook - RUNBOOK.md (the three live acceptances)", () => {
  it("references 402 (the live HTTPS paywall acceptance)", () => {
    expect(RUNBOOK).toContain("402");
  });

  it("references the malicious-probe-blocked acceptance (SBX-02/06)", () => {
    expect(RUNBOOK).toContain("SBX-02");
    expect(RUNBOOK).toContain("SBX-06");
    expect(RUNBOOK.toLowerCase()).toContain("malicious");
  });

  it("references the runsc-enforced limits acceptance (SBX-04)", () => {
    expect(RUNBOOK).toContain("SBX-04");
    expect(RUNBOOK).toContain("runsc");
  });

  it("references the live HTTPS 402->200 acceptance + the live-deploy script (DEP-01/02, PRX-02)", () => {
    expect(RUNBOOK).toContain("DEP-01");
    expect(RUNBOOK).toContain("DEP-02");
    expect(RUNBOOK).toContain("PRX-02");
    expect(RUNBOOK).toContain("live-deploy");
    expect(RUNBOOK).toContain("liveDeployEcho");
  });

  it("records the acceptances as Deferred Items, NOT autonomous phase blockers", () => {
    expect(RUNBOOK.toLowerCase()).toContain("deferred item");
    expect(RUNBOOK.toLowerCase()).toContain("not autonomous phase blocker");
  });
});

describe("probe-runbook - PROVISION.md (gVisor host provisioning)", () => {
  it("references runsc + the daemon.json runtime", () => {
    expect(PROVISION).toContain("runsc");
    expect(PROVISION).toContain("daemon.json");
    expect(PROVISION).toContain("runsc install");
  });

  it("states docker-dev / Docker Desktop is NOT a security boundary", () => {
    expect(PROVISION).toContain("NOT a");
    expect(PROVISION.toLowerCase()).toContain("security boundary");
    expect(PROVISION.toLowerCase()).toContain("docker-dev");
  });

  it("references the quota-capable storage driver for disk quota (SBX-04)", () => {
    expect(PROVISION).toContain("overlay2");
    expect(PROVISION.toLowerCase()).toContain("pquota");
  });

  it("references the wildcard TLS / DNS-01 provisioning", () => {
    expect(PROVISION).toContain("DNS-01");
    expect(PROVISION).toContain("*.resources.");
  });
});

describe("probe-runbook - nftables.rules.sh (host-side egress firewall)", () => {
  it("carries a HOST-only header (never an in-container rule)", () => {
    expect(NFTABLES).toContain("HOST");
    expect(NFTABLES.toLowerCase()).toContain("never inside the untrusted container");
  });

  it("carries only the metadata SUBSET of EGRESS_BLOCK_SET; the rest lives in the data-proxy firewall", () => {
    // The descoped host-output chain deliberately carries only a SUBSET of
    // EGRESS_BLOCK_SET: the link-local/metadata entry. The full container-egress
    // block set (RFC1918 + loopback) is enforced by the data-proxy firewall
    // (services/sandbox/src/egress/firewall.ts) and a tracked forward-path
    // DOCKER-USER TODO, NOT by this host-output chain. The full block-set coverage
    // lives in firewall.test.ts ("firewall - the block set"); this test only
    // documents the host chain's deliberate subset.
    const metadata = "169.254.0.0/16";
    // EGRESS_BLOCK_SET still imported + used: the metadata entry IS present host-side.
    expect(EGRESS_BLOCK_SET.some((e) => e.cidr === metadata)).toBe(true);
    expect(NFTABLES).toContain(metadata);
    // Every non-metadata, non-loopback EGRESS_BLOCK_SET entry (the RFC1918 ranges)
    // is NOT carried as a host drop rule - it is the data-proxy firewall's job.
    for (const entry of EGRESS_BLOCK_SET) {
      if (entry.cidr === metadata || entry.cidr === "127.0.0.0/8") continue;
      expect(NFTABLES).not.toContain(`ip daddr ${entry.cidr} drop`);
    }
  });

  it("drops ONLY link-local/metadata + the Arc RPC (no RFC1918, loopback, or facilitator drops)", () => {
    // The descoped host denylist drops only the two host-only destinations.
    expect(NFTABLES).toContain("169.254.0.0/16");
    expect(NFTABLES).toContain("ARC_RPC_IP");
    // The RFC1918 + loopback drops were removed: on a host-output chain they break
    // host->container and loopback traffic while never touching the container's
    // FORWARDED egress. Assert against the `drop` rule form (the CIDRs appear
    // nowhere in this file, but the rule form is the robust assertion).
    expect(NFTABLES).not.toContain("ip daddr 10.0.0.0/8 drop");
    expect(NFTABLES).not.toContain("ip daddr 172.16.0.0/12 drop");
    expect(NFTABLES).not.toContain("ip daddr 192.168.0.0/16 drop");
    expect(NFTABLES).not.toContain("ip daddr 127.0.0.0/8 drop");
    // The facilitator drop was removed too (host reaches the facilitator container
    // via host->container traffic; dropping it would break the deployer->facilitator hop).
    expect(NFTABLES).not.toContain("FACILITATOR_IP");
  });

  it("is a MINIMAL policy-ACCEPT denylist with SSH self-preservation (not a default-drop boundary)", () => {
    // The active chain declaration is policy accept, never policy drop. (Prose in
    // the header mentions a future "flip back to policy drop", so assert against the
    // chain-decl line form `policy drop;`, not the bare substring.)
    expect(NFTABLES).toContain("policy accept;");
    expect(NFTABLES).not.toContain("policy drop;");
    // SSH + loopback + established self-preservation so a flip to drop can never
    // silently lock the operator out.
    expect(NFTABLES).toContain("tcp sport 22 accept");
    expect(NFTABLES).toContain('oifname "lo" accept');
    expect(NFTABLES).toContain("ct state established,related accept");
    // This host chain is NOT the container boundary, so it carries no data-proxy
    // accept (that is the data-proxy firewall's domain, firewall.ts).
    expect(NFTABLES).not.toContain("DATA_PROXY_IP");
    expect(NFTABLES).not.toContain("DATA_PROXY_PORT");
  });

  it("refuses to run unless UTTER_SANDBOX_HOST=1 (cannot run on a dev box)", () => {
    expect(NFTABLES).toContain("UTTER_SANDBOX_HOST");
  });
});

describe("probe-runbook - the live probe stays guarded in the autonomous suite", () => {
  it("the operator-gated default is unavailable and throws requiresProvisionedHost", async () => {
    const probe = createOperatorGatedProbe();
    expect(probe.available).toBe(false);
    const spec = {} as RunSpec;
    await expect(probe.assertBlocked(spec, [...DEFAULT_PROBE_TARGETS])).rejects.toBeInstanceOf(
      RequiresProvisionedHostError,
    );
    await expect(probe.assertBlocked(spec, [...DEFAULT_PROBE_TARGETS])).rejects.toMatchObject({
      code: "requiresProvisionedHost",
    });
  });

  it("createLiveHostProbe REFUSES a non-gvisor runner (docker-dev is never a boundary)", () => {
    const dockerDevRunner = { backend: "docker-dev" } as unknown as SandboxRunner;
    expect(() => createLiveHostProbe({ runner: dockerDevRunner })).toThrow(RequiresProvisionedHostError);
  });

  it("createLiveHostProbe is operator-runnable with a gvisor runner (available:true)", () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveHostProbe({ runner: gvisorRunner });
    expect(probe.available).toBe(true);
    expect(DEFAULT_PROBE_IMAGE).toContain("blocked-host-probe");
  });

  it("the live probe throws ContainmentFailureError when a target is reachable (injected stub)", async () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    // Inject a connectProbe that reports the metadata host as REACHABLE (a
    // containment failure) and everything else blocked - no container launch.
    const probe = createLiveHostProbe({
      runner: gvisorRunner,
      connectProbe: async (_spec, target) => target.host === "169.254.0.0",
    });
    const spec = {} as RunSpec;
    await expect(probe.assertBlocked(spec, [])).rejects.toBeInstanceOf(ContainmentFailureError);
  });

  it("the live probe resolves when every target is unreachable (injected stub)", async () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveHostProbe({
      runner: gvisorRunner,
      connectProbe: async () => false, // everything unreachable (the blocked-OK path)
    });
    const spec = {} as RunSpec;
    await expect(probe.assertBlocked(spec, [...DEFAULT_PROBE_TARGETS])).resolves.toBeUndefined();
  });

  it("the DEFAULT connectProbe THROWS a clear error (cannot pass a dynamic target through the locked RunSpec)", async () => {
    // No connectProbe injected: the default cannot build a valid reference (the old
    // `${image}#${host}` is an invalid Docker reference), so it must fail LOUD - never
    // silently build the bad reference. A connectProbe is required on the host.
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveHostProbe({ runner: gvisorRunner });
    const spec = {} as RunSpec;
    await expect(probe.assertBlocked(spec, [...DEFAULT_PROBE_TARGETS])).rejects.toThrow(
      /connectProbe must be injected/i,
    );
  });
});

describe("probe-runbook - the sibling-unreachability probe stays guarded (PRX-02, quick 260625-mwb)", () => {
  // A sibling handler + sidecar (DISALLOWED cross-tenant) plus the resource's own
  // data-proxy (the explicitly ALLOWED peer).
  const SIBLINGS: SiblingTarget[] = [
    { role: "handler", ip: "172.31.0.7", port: 8080, reason: "sibling-handler" },
    { role: "sidecar", ip: "172.20.0.8", port: 8080, reason: "sibling-sidecar" },
    { role: "data-proxy", ip: "172.30.0.10", port: 3128, reason: "own-data-proxy" },
  ];

  it("the operator-gated default is unavailable and throws requiresProvisionedHost", async () => {
    const probe = createOperatorGatedSiblingProbe();
    expect(probe.available).toBe(false);
    const spec = {} as RunSpec;
    await expect(probe.assertUnreachable(spec, SIBLINGS)).rejects.toBeInstanceOf(
      RequiresProvisionedHostError,
    );
    await expect(probe.assertUnreachable(spec, SIBLINGS)).rejects.toMatchObject({
      code: "requiresProvisionedHost",
    });
  });

  it("createLiveSiblingProbe REFUSES a non-gvisor runner (docker-dev is never a boundary)", () => {
    const dockerDevRunner = { backend: "docker-dev" } as unknown as SandboxRunner;
    expect(() => createLiveSiblingProbe({ runner: dockerDevRunner })).toThrow(
      RequiresProvisionedHostError,
    );
  });

  it("createLiveSiblingProbe is operator-runnable with a gvisor runner (available:true)", () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveSiblingProbe({ runner: gvisorRunner });
    expect(probe.available).toBe(true);
  });

  it("throws SiblingUnreachabilityError when a DISALLOWED sibling handler is reachable", async () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    // The sibling HANDLER is reachable (an isolation failure); everything else blocked.
    const probe = createLiveSiblingProbe({
      runner: gvisorRunner,
      connectProbe: async (_spec, s) => s.role === "handler" && s.ip === "172.31.0.7",
    });
    const spec = {} as RunSpec;
    await expect(probe.assertUnreachable(spec, SIBLINGS)).rejects.toBeInstanceOf(
      SiblingUnreachabilityError,
    );
    await expect(probe.assertUnreachable(spec, SIBLINGS)).rejects.toMatchObject({
      code: "siblingReachable",
    });
  });

  it("throws SiblingUnreachabilityError when a DISALLOWED sibling sidecar is reachable", async () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveSiblingProbe({
      runner: gvisorRunner,
      connectProbe: async (_spec, s) => s.role === "sidecar",
    });
    const spec = {} as RunSpec;
    await expect(probe.assertUnreachable(spec, SIBLINGS)).rejects.toBeInstanceOf(
      SiblingUnreachabilityError,
    );
  });

  it("resolves when every DISALLOWED sibling is unreachable (the isolated-OK path)", async () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveSiblingProbe({
      runner: gvisorRunner,
      connectProbe: async () => false, // every sibling unreachable
    });
    const spec = {} as RunSpec;
    await expect(probe.assertUnreachable(spec, SIBLINGS)).resolves.toBeUndefined();
  });

  it("does NOT probe the allowed data-proxy peer (only disallowed siblings are checked)", async () => {
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probedRoles: string[] = [];
    const probe = createLiveSiblingProbe({
      runner: gvisorRunner,
      connectProbe: async (_spec, s) => {
        probedRoles.push(s.role);
        return false;
      },
    });
    const spec = {} as RunSpec;
    await probe.assertUnreachable(spec, SIBLINGS);
    // The data-proxy peer is allowed and therefore never probed; only the cross-tenant
    // handler + sidecar are checked.
    expect(probedRoles.sort()).toEqual(["handler", "sidecar"]);
    expect(probedRoles).not.toContain("data-proxy");
  });

  it("the DEFAULT connectProbe THROWS a clear error (cannot pass a dynamic target through the locked RunSpec)", async () => {
    // Same as createLiveHostProbe: no injected connectProbe means there is no valid way
    // to pass the dynamic sibling target, so the default must fail LOUD rather than build
    // the invalid `${image}#${ip}:${port}` reference.
    const gvisorRunner = { backend: "gvisor" } as unknown as SandboxRunner;
    const probe = createLiveSiblingProbe({ runner: gvisorRunner });
    const spec = {} as RunSpec;
    await expect(probe.assertUnreachable(spec, SIBLINGS)).rejects.toThrow(
      /connectProbe must be injected/i,
    );
  });
});
