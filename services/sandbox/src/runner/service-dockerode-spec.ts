// toServiceDockerodeCreateOptions - translate a hardened ResourceServiceSpec
// into a dockerode container create-spec for the long-lived service profile.
//
// It copies the SAME hardening block as toDockerodeCreateOptions (read-only
// root, cap-drop ALL, no-new-privileges, pids/mem/cpu, hardened tmpfs, runsc vs
// runc) and adds only the four deployment fields: the container name, the
// allowlisted Env, the named NetworkMode, the HostConfig.RestartPolicy, and the
// exposed listen port. dockerode-spec.ts is untouched.
//
// As with the one-shot translator it NEVER sets Privileged and NEVER uses host
// networking - those invariants are guaranteed at the spec level
// (service-runspec.ts rejects "host"/"none") and preserved here.
import type Docker from "dockerode";
import type { ResourceServiceSpec } from "./types";

/** Parse a tmpfs option string into Docker's HostConfig.Tmpfs shape. */
function tmpfsToHostConfig(tmpfs: Record<string, string>): Record<string, string> {
  return { ...tmpfs };
}

/** Convert a cpus float (e.g. 0.5) to NanoCpus (1e9 == 1 cpu). */
function nanoCpus(spec: ResourceServiceSpec): number {
  return Math.round(spec.cpus * 1_000_000_000);
}

/**
 * Map the service restart policy to dockerode's HostRestartPolicy shape
 * ({ Name, MaximumRetryCount? }). MaximumRetryCount is sent only for
 * "on-failure" (Docker ignores it for the other names, and rejects a non-zero
 * value paired with "unless-stopped"/"no").
 */
function restartPolicy(spec: ResourceServiceSpec): Docker.HostRestartPolicy {
  const { name, maxRetryCount } = spec.restartPolicy;
  if (name === "on-failure" && maxRetryCount !== undefined) {
    return { Name: name, MaximumRetryCount: maxRetryCount };
  }
  return { Name: name };
}

/**
 * Map a ResourceServiceSpec to dockerode ContainerCreateOptions. Carries every
 * hardening flag identical to the one-shot translator; adds the stable name, the
 * allowlisted Env, the named NetworkMode, the restart policy, and the exposed
 * port. Never sets Privileged or host networking.
 */
export function toServiceDockerodeCreateOptions(
  spec: ResourceServiceSpec,
): Docker.ContainerCreateOptions {
  // Env is the allowlisted, secret-guarded map (built by buildServiceEnv).
  const env: string[] = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);

  const storageOpt =
    spec.storageOptSize !== undefined ? { size: spec.storageOptSize } : undefined;

  // Dockerode ExposedPorts is a set keyed by "<port>/<proto>" -> {}.
  const portKey = `${spec.port}/tcp`;

  return {
    name: spec.name,
    Image: spec.image,
    Env: env,
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      Runtime: spec.runtime, // runsc (gvisor) | runc (docker-dev)
      NetworkMode: spec.network, // a NAMED internal network (never "host"/"none")
      ReadonlyRootfs: spec.readonlyRootfs,
      Tmpfs: tmpfsToHostConfig(spec.tmpfs),
      CapDrop: [...spec.capDrop],
      // CapAdd intentionally omitted (the invariant forbids it; spec.capAdd is []).
      SecurityOpt: [...spec.securityOpt],
      PidsLimit: spec.pidsLimit,
      Memory: spec.memoryBytes,
      NanoCpus: nanoCpus(spec),
      RestartPolicy: restartPolicy(spec),
      ...(storageOpt ? { StorageOpt: storageOpt } : {}),
      // Privileged is NEVER set (defaults false). Host networking is NEVER used.
    },
  };
}
