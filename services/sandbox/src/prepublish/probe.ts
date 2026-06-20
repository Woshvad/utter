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
