// toDockerodeCreateOptions - translate a hardened RunSpec into a dockerode
// container create-spec (shared by the gvisor + docker-dev backends).
//
// This is the single place the pure RunSpec is mapped onto the Docker Remote API
// HostConfig. Both backends call it so the hardening (read-only root, cap-drop
// ALL, no-new-privileges, pids/mem/cpu, empty env, network none) is applied
// identically; the ONLY backend difference is `Runtime` (runsc vs runc). The
// translation deliberately NEVER sets `Privileged`, NEVER sets
// `NetworkMode:"host"`, and NEVER adds capabilities - those are the invariants
// asserted at the RunSpec level (runspec.test.ts) and preserved here.
import type Docker from "dockerode";
import type { RunSpec } from "./types";

/** Parse a tmpfs option string into Docker's `--tmpfs` HostConfig.Tmpfs shape. */
function tmpfsToHostConfig(tmpfs: Record<string, string>): Record<string, string> {
  // dockerode HostConfig.Tmpfs is `{ "/path": "opt,opt" }` - same shape.
  return { ...tmpfs };
}

/** Convert bytes -> the dockerode Memory field (bytes). */
function memory(spec: RunSpec): number {
  return spec.memoryBytes;
}

/** Convert a cpus float (e.g. 0.5) to NanoCpus (1e9 == 1 cpu). */
function nanoCpus(spec: RunSpec): number {
  return Math.round(spec.cpus * 1_000_000_000);
}

/**
 * Map a RunSpec to dockerode `ContainerCreateOptions`. Carries every hardening
 * flag; never sets Privileged or host networking; env is exactly empty.
 */
export function toDockerodeCreateOptions(spec: RunSpec): Docker.ContainerCreateOptions {
  // Env MUST be empty (SBX-03). Render it explicitly so a stray key is visible.
  const env: string[] = Object.entries(spec.env).map(([k, v]) => `${k}=${v as string}`);

  const storageOpt =
    spec.storageOptSize !== undefined ? { size: spec.storageOptSize } : undefined;

  return {
    Image: spec.image,
    // No platform/key env in the container.
    Env: env,
    HostConfig: {
      Runtime: spec.runtime, // runsc (gvisor) | runc (docker-dev)
      NetworkMode: spec.network, // "none": the firewall attaches the only route host-side
      ReadonlyRootfs: spec.readonlyRootfs,
      Tmpfs: tmpfsToHostConfig(spec.tmpfs),
      CapDrop: [...spec.capDrop],
      // CapAdd is intentionally omitted (the invariant forbids it). spec.capAdd
      // is the empty list - we never spread anything onto CapAdd.
      SecurityOpt: [...spec.securityOpt],
      PidsLimit: spec.pidsLimit,
      Memory: memory(spec),
      NanoCpus: nanoCpus(spec),
      ...(storageOpt ? { StorageOpt: storageOpt } : {}),
      // Privileged is NEVER set (defaults false). Host networking is NEVER used.
    },
  };
}
