// probe.ts - the dynamic blocked-host probe (SBX-06c) interface + an
// OPERATOR-GATED stub.
//
// The dynamic probe runs the bundle inside the gVisor sandbox on the
// provisioned host and asserts it CANNOT reach a blocked host (cloud metadata
// 169.254.169.254, an RFC1918 host, the Arc RPC, the facilitator, the host).
// This is the live SBX-02/06 DoD and it REQUIRES the operator-provisioned
// isolation host - it is NOT autonomous (the docker-dev backend is not a
// security boundary, so a probe against it would be meaningless or, worse,
// actually attempt the SSRF). It is therefore scheduled in the operator-gated
// Plan 06; this file ships the interface + a stub that refuses to run
// autonomously.
import type { RunSpec } from "../runner/types";
import type { SandboxRunner } from "../runner/types";
import { EGRESS_BLOCK_SET } from "../egress/firewall";

/** A host the probe asserts is unreachable from inside the sandbox. */
export interface ProbeTarget {
  /** A label for the target (e.g. "cloud-metadata", "arc-rpc"). */
  name: string;
  /** The host/IP that must be unreachable. */
  host: string;
}

/**
 * The dynamic blocked-host probe. `assertBlocked` runs the bundle in the gVisor
 * sandbox and resolves ONLY if every target is unreachable; it rejects if any
 * target is reachable (a containment failure) or if it is invoked without the
 * provisioned host.
 */
export interface DynamicHostProbe {
  /** True only on the provisioned gVisor host; the stub is always false. */
  readonly available: boolean;
  /**
   * Run the bundle under the hardened run-spec and assert every target is
   * unreachable. Operator-gated: requires the provisioned isolation host.
   */
  assertBlocked(spec: RunSpec, targets: ProbeTarget[]): Promise<void>;
}

/** The error thrown when the probe is invoked without the provisioned host. */
export class RequiresProvisionedHostError extends Error {
  readonly code = "requiresProvisionedHost" as const;
  constructor() {
    super(
      "DynamicHostProbe requires the operator-provisioned gVisor host (runsc + host firewall). " +
        "The live blocked-host probe is operator-gated (Plan 06); it is NOT autonomous.",
    );
    this.name = "RequiresProvisionedHostError";
  }
}

/** The default block-probe targets the live acceptance asserts unreachable. */
export const DEFAULT_PROBE_TARGETS: readonly ProbeTarget[] = [
  { name: "cloud-metadata", host: "169.254.169.254" },
  { name: "rfc1918", host: "10.0.0.1" },
  { name: "arc-rpc", host: "ARC_RPC_IP" },
  { name: "facilitator", host: "FACILITATOR_IP" },
  { name: "host-loopback", host: "127.0.0.1" },
] as const;

/**
 * The error thrown when the live probe finds a target REACHABLE from inside the
 * sandbox - a containment failure that MUST fail publication (SBX-02/06).
 */
export class ContainmentFailureError extends Error {
  readonly code = "containmentFailure" as const;
  public readonly reachable: ProbeTarget[];

  constructor(reachable: ProbeTarget[]) {
    super(
      "Sandbox containment FAILED: the following blocked hosts were reachable from " +
        `inside the container netns: ${reachable.map((t) => `${t.name} (${t.host})`).join(", ")}. ` +
        "The egress firewall (host nftables / --network=none veth) is not enforcing the block set.",
    );
    this.reachable = reachable;
    this.name = "ContainmentFailureError";
  }
}

/**
 * Build the operator-gated probe stub. It is NEVER available autonomously:
 * `available` is false and `assertBlocked` throws `RequiresProvisionedHostError`
 * so the autonomous suite cannot mistake it for a live security pass. The real
 * implementation is wired against the gVisor backend on the provisioned host in
 * Plan 06.
 */
export function createOperatorGatedProbe(): DynamicHostProbe {
  return {
    available: false,
    async assertBlocked(): Promise<void> {
      throw new RequiresProvisionedHostError();
    },
  };
}

/**
 * The shape of the small probe-tester image the live probe launches: a curl/nc
 * attempt against ONE target host. The image exits non-zero when the host is
 * UNREACHABLE (the desired containment outcome) and zero when it IS reachable
 * (the containment failure). The operator builds it on the provisioned host; the
 * default `connectProbe` here shells the runner's `run`/`logs` against it.
 */
export interface LiveProbeOptions {
  /**
   * The runner to launch the probe container with. MUST be the `gvisor` backend
   * on the provisioned host - the live probe is meaningless against `docker-dev`
   * (not a security boundary), so this throws if handed a non-gvisor runner.
   */
  runner: SandboxRunner;
  /**
   * The probe image that, given a target host (via the run-spec image tag or a
   * one-shot command), attempts a TCP connect + an HTTP GET. Defaults to a
   * convention tag the operator builds per PROVISION.md.
   */
  probeImage?: string;
  /**
   * Connect-attempt seam: returns `true` if `host` was REACHABLE from inside the
   * container, `false` if the connect was refused/timed out (the blocked-OK
   * path). The default drives the runner; tests inject a deterministic stub.
   */
  connectProbe?: (spec: RunSpec, target: ProbeTarget) => Promise<boolean>;
}

/** The default probe-tester image tag the operator builds on the provisioned host. */
export const DEFAULT_PROBE_IMAGE = "utter/blocked-host-probe:latest";

/**
 * Build the LIVE blocked-host probe (operator-runnable, SBX-02/06).
 *
 * Unlike the autonomous stub, this probe ACTUALLY launches the probe-tester
 * container under the supplied gVisor runner and attempts to reach every target
 * (the full `EGRESS_BLOCK_SET` plus the supplied per-deploy targets) from inside
 * the container netns. `assertBlocked` resolves ONLY if every target is
 * unreachable; if any target is reachable it throws `ContainmentFailureError`
 * (publication MUST fail).
 *
 * It is GUARDED so it can never run in the autonomous suite: the factory throws
 * `RequiresProvisionedHostError` unless handed a `gvisor` runner (the only
 * trusted boundary - the `docker-dev` backend is explicitly rejected because a
 * probe against it is meaningless or, worse, would actually perform the SSRF).
 * The default suite never constructs a gvisor runner, so the live path is only
 * reached on the provisioned host via the runbook.
 */
export function createLiveHostProbe(options: LiveProbeOptions): DynamicHostProbe {
  if (options.runner.backend !== "gvisor") {
    // The live probe is operator-gated: only the gVisor backend on the
    // provisioned host is a trusted boundary. Refuse anything else so the
    // autonomous suite (docker-dev / in-memory) can never run it live.
    throw new RequiresProvisionedHostError();
  }

  // The probe runs against a DYNAMIC target host, but the untrusted RunSpec is
  // locked (env is Record<string, never>, no cmd field), so the target cannot be
  // passed through it. The old default tried to encode the target in the image
  // tag (`${probeImage}#${target.host}`), which Docker rejects with
  // "invalid reference format". The probe is a TRUSTED operator tool, so the host
  // caller (deployer runEgressProbe) injects a connectProbe that launches the
  // probe image directly via dockerode (target in Cmd, handler netns). With no
  // injected connectProbe there is no valid way to pass the target, so fail loud
  // rather than build an invalid reference.
  const connectProbe =
    options.connectProbe ??
    (async (): Promise<boolean> => {
      throw new Error(
        "createLiveHostProbe: a connectProbe must be injected on the host - the default " +
          "cannot pass a dynamic target through the locked RunSpec (empty env, no cmd). The " +
          "host caller (deployer runEgressProbe) injects a connectProbe that launches " +
          "utter/blocked-host-probe in the handler netns. See " +
          "infrastructure/sandbox-host/blocked-host-probe/README.",
      );
    });

  return {
    available: true,
    async assertBlocked(spec: RunSpec, targets: ProbeTarget[]): Promise<void> {
      // Probe the full static block set (resolved to representative hosts) plus
      // every per-deploy target the caller supplied (the Arc RPC + facilitator
      // IPs resolved at deploy time).
      const blockSetTargets: ProbeTarget[] = EGRESS_BLOCK_SET.map((e) => ({
        name: e.reason,
        // The block set is CIDR/IP; probe the network/representative address.
        host: e.cidr.split("/")[0] ?? e.cidr,
      }));
      const allTargets = [...blockSetTargets, ...targets];

      const reachable: ProbeTarget[] = [];
      for (const target of allTargets) {
        const isReachable = await connectProbe(spec, target);
        if (isReachable) reachable.push(target);
      }
      if (reachable.length > 0) {
        throw new ContainmentFailureError(reachable);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sibling-unreachability probe (quick 260625-mwb, PRX-02): the cross-tenant
// counterpart to the blocked-host probe. Per-resource pairnet isolation puts each
// handler on its own internal bridge `utter_pairnet_<slug>`, so a handler must NOT be
// able to reach a SIBLING handler or a sibling sidecar at L3. This probe runs from a
// handler and asserts every DISALLOWED sibling IP is unreachable. The only allowed
// peer is the resource's own data-proxy (the future untrusted-egress path); a sibling
// handler or sidecar that is reachable is an isolation failure that MUST be surfaced.
// ---------------------------------------------------------------------------

/** A sibling endpoint the probe classifies as allowed (own data-proxy) or disallowed. */
export interface SiblingTarget {
  /** The sibling's role: another tenant's handler/sidecar, or the resource's own data-proxy. */
  role: "handler" | "sidecar" | "data-proxy";
  /** The sibling's IP that must (handler/sidecar) or may (data-proxy) be reachable. */
  ip: string;
  /** The port to probe. */
  port: number;
  /** An optional human label for the reachability report. */
  reason?: string;
}

/**
 * The error thrown when a DISALLOWED sibling (another tenant's handler or sidecar) is
 * reachable from inside the handler netns - a per-resource isolation failure that MUST
 * fail the acceptance (PRX-02). Carries the reachable disallowed siblings.
 */
export class SiblingUnreachabilityError extends Error {
  readonly code = "siblingReachable" as const;
  public readonly reachable: SiblingTarget[];

  constructor(reachable: SiblingTarget[]) {
    super(
      "Per-resource isolation FAILED: the following DISALLOWED siblings were reachable " +
        `from inside the handler netns: ${reachable
          .map((t) => `${t.role} ${t.ip}:${t.port}`)
          .join(", ")}. ` +
        "The per-slug internal pairnet is the SOLE enforcement of handler-sibling isolation; " +
        "a reachable sibling means the disjoint-bridge segmentation is not holding.",
    );
    this.reachable = reachable;
    this.name = "SiblingUnreachabilityError";
  }
}

/**
 * The sibling-unreachability probe. `assertUnreachable` runs from a handler and
 * resolves ONLY if every DISALLOWED sibling (handler/sidecar) is unreachable; it
 * rejects with {@link SiblingUnreachabilityError} if any disallowed sibling is
 * reachable, or with {@link RequiresProvisionedHostError} if invoked without the host.
 */
export interface SiblingProbe {
  /** True only on the provisioned gVisor host; the stub is always false. */
  readonly available: boolean;
  /**
   * Probe each sibling and assert every DISALLOWED one (role handler/sidecar) is
   * unreachable. The allowed peer (role "data-proxy") is never required to be blocked.
   * Operator-gated: requires the provisioned isolation host.
   */
  assertUnreachable(spec: RunSpec, siblings: SiblingTarget[]): Promise<void>;
}

/**
 * Build the operator-gated sibling-probe stub. It is NEVER available autonomously:
 * `available` is false and `assertUnreachable` throws `RequiresProvisionedHostError`
 * so the autonomous suite cannot mistake it for a live isolation pass. The real
 * implementation is wired against the gVisor backend on the provisioned host.
 */
export function createOperatorGatedSiblingProbe(): SiblingProbe {
  return {
    available: false,
    async assertUnreachable(): Promise<void> {
      throw new RequiresProvisionedHostError();
    },
  };
}

/** Options for {@link createLiveSiblingProbe} (mirrors {@link LiveProbeOptions}). */
export interface LiveSiblingProbeOptions {
  /**
   * The runner to launch the probe container with. MUST be the `gvisor` backend on
   * the provisioned host - the live probe is meaningless against `docker-dev` (not a
   * security boundary), so this throws if handed a non-gvisor runner.
   */
  runner: SandboxRunner;
  /** The probe image (defaults to the same convention tag as the blocked-host probe). */
  probeImage?: string;
  /**
   * Connect-attempt seam: returns `true` if the sibling was REACHABLE from inside the
   * handler container, `false` if the connect was refused/timed out (the isolated-OK
   * path). The default drives the runner; tests inject a deterministic stub.
   */
  connectProbe?: (spec: RunSpec, sibling: SiblingTarget) => Promise<boolean>;
}

/**
 * Build the LIVE sibling-unreachability probe (operator-runnable, PRX-02).
 *
 * Mirrors {@link createLiveHostProbe}: it is GUARDED so it can never run in the
 * autonomous suite (the factory throws `RequiresProvisionedHostError` unless handed a
 * `gvisor` runner). On the provisioned host it launches the probe-tester container
 * under the supplied gVisor runner and attempts to reach each sibling from inside the
 * handler netns. `assertUnreachable` probes ONLY the DISALLOWED siblings (role
 * handler/sidecar); the allowed peer (role "data-proxy") is skipped. If any disallowed
 * sibling is reachable it throws {@link SiblingUnreachabilityError}; otherwise it
 * resolves (every cross-tenant sibling is blocked).
 */
export function createLiveSiblingProbe(options: LiveSiblingProbeOptions): SiblingProbe {
  if (options.runner.backend !== "gvisor") {
    // The live probe is operator-gated: only the gVisor backend on the provisioned
    // host is a trusted boundary. Refuse anything else so the autonomous suite
    // (docker-dev / in-memory) can never run it live.
    throw new RequiresProvisionedHostError();
  }

  // Same as createLiveHostProbe: the sibling target is DYNAMIC but the untrusted
  // RunSpec is locked (empty env, no cmd), so it cannot carry the target. The old
  // default encoded it in the image tag (`${probeImage}#${ip}:${port}`), which
  // Docker rejects as an invalid reference. The host caller injects a connectProbe
  // that launches the probe image directly via dockerode; with none injected there
  // is no valid construction, so fail loud rather than build an invalid reference.
  const connectProbe =
    options.connectProbe ??
    (async (): Promise<boolean> => {
      throw new Error(
        "createLiveSiblingProbe: a connectProbe must be injected on the host - the default " +
          "cannot pass a dynamic target through the locked RunSpec (empty env, no cmd). The " +
          "host caller injects a connectProbe that launches utter/blocked-host-probe in the " +
          "handler netns. See infrastructure/sandbox-host/blocked-host-probe/README.",
      );
    });

  return {
    available: true,
    async assertUnreachable(spec: RunSpec, siblings: SiblingTarget[]): Promise<void> {
      // Only DISALLOWED siblings (cross-tenant handler/sidecar) must be unreachable;
      // the resource's own data-proxy is the explicitly allowed peer and is skipped.
      const disallowed = siblings.filter((s) => s.role !== "data-proxy");

      const reachable: SiblingTarget[] = [];
      for (const sibling of disallowed) {
        const isReachable = await connectProbe(spec, sibling);
        if (isReachable) reachable.push(sibling);
      }
      if (reachable.length > 0) {
        throw new SiblingUnreachabilityError(reachable);
      }
    },
  };
}
