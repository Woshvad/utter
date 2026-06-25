// buildResourceServiceSpec - the PURE hardened builder for the long-lived
// resource-service profile (RESOURCE-DEPLOY-DESIGN.md §2.2/§2.3).
//
// This is the additive sibling of buildRunSpec. It keeps EVERY isolation flag of
// the one-shot spec (runsc/runc, readonly root, capDrop ALL, capAdd [],
// no-new-privileges, pids/mem/cpu, hardened tmpfs) and relaxes ONLY four
// deployment fields:
//   1. network  - a NAMED internal Docker network (rejects "host"/"none"),
//   2. env      - a secret-guarded non-secret allowlist (buildServiceEnv),
//   3. name     - a stable namespaced container name (^utter_res_[a-z0-9-]+$),
//   4. restartPolicy - default on-failure with a max-retry cap (review H4).
//
// There is NO timeoutSeconds field on ResourceServiceSpec at all: a long-lived
// service must not auto-kill, and the property is enforced by ABSENCE so no edit
// can re-enable a deadline without re-adding the field.
//
// It reuses runtimeFor / hardenTmpfs / DEFAULT_TMPFS from runspec.ts so the
// hardening derivation is byte-identical to the one-shot path (no fork of the
// isolation logic). The one-shot buildRunSpec / RunSpec are untouched.
import { DEFAULT_TMPFS, hardenTmpfs, runtimeFor, type RunLimits } from "./runspec";
import { buildServiceEnv } from "./service-env";
import type { RunBackend, ResourceServiceSpec, ServiceRestartPolicy } from "./types";

/** The required container-name shape: namespaced + lowercase + dns-safe. */
export const SERVICE_NAME_PATTERN = /^utter_res_[a-z0-9-]+$/;

/**
 * The default restart policy: on-failure with a bounded retry cap (security
 * review H4 - NOT unless-stopped). A crashing untrusted handler must not
 * restart-loop forever and burn the host. The cap is a small fixed bound, not a
 * money/scale literal.
 */
export const DEFAULT_SERVICE_RESTART_POLICY: ServiceRestartPolicy = {
  name: "on-failure",
  maxRetryCount: 5,
};

/** Inputs to {@link buildResourceServiceSpec}. */
export interface BuildResourceServiceSpecOptions {
  /** gvisor (runsc) or docker-dev (runc, NOT a boundary). */
  backend: RunBackend;
  /** The resource image to launch as a long-lived service. */
  image: string;
  /** The resource resource limits (shared with the one-shot profile). */
  limits: RunLimits;
  /**
   * The NAMED internal Docker network the service joins. The builder REJECTS
   * "host" and "none": the service must be DNS-reachable by Traefik and reach
   * the facilitator, and "none" makes both impossible; "host" is forbidden by
   * the isolation invariant.
   */
  network: string;
  /** The raw config map (validated + allowlisted by buildServiceEnv). */
  env: Record<string, string>;
  /** The stable container name (must match SERVICE_NAME_PATTERN). */
  name: string;
  /** The container listen port Traefik routes to. */
  port: number;
  /** Optional restart policy override; defaults to on-failure + cap (H4). */
  restartPolicy?: ServiceRestartPolicy;
  /** Optional tmpfs mounts (forced noexec,nosuid); defaults to a small /tmp. */
  tmpfs?: Record<string, string>;
  /**
   * Optional non-secret container labels (resourceId/slug, for the reconcile loop
   * to read managed containers back). No secret guard is applied: these are
   * operator-set identity/routing metadata, NOT handler-supplied env. Absent leaves
   * the spec isolation-identical.
   */
  labels?: Record<string, string>;
}

/**
 * Build the hardened spec for one long-lived resource-service container.
 *
 * Isolation invariants (asserted in service-runspec.test.ts, identical to the
 * one-shot spec): runtime runsc for gvisor, readonlyRootfs true, capDrop ALL,
 * capAdd [], no-new-privileges, positive pids/mem/cpu, hardened tmpfs. The four
 * relaxed fields are validated here.
 *
 * @throws if a limit or the port is non-positive, the image is missing, the
 *         name does not match SERVICE_NAME_PATTERN, the network is "host"/"none"
 *         or empty, or buildServiceEnv rejects the env.
 */
export function buildResourceServiceSpec(
  opts: BuildResourceServiceSpecOptions,
): ResourceServiceSpec {
  const { backend, image, limits, network, name, port } = opts;

  if (!image) throw new Error("buildResourceServiceSpec: image is required");
  if (limits.pidsLimit <= 0) throw new Error("buildResourceServiceSpec: pidsLimit must be > 0");
  if (limits.memoryBytes <= 0) {
    throw new Error("buildResourceServiceSpec: memoryBytes must be > 0");
  }
  if (limits.cpus <= 0) throw new Error("buildResourceServiceSpec: cpus must be > 0");
  if (port <= 0) throw new Error("buildResourceServiceSpec: port must be > 0");

  // Relaxation guard 1: a named network only. "host" is a forbidden isolation
  // break; "none" defeats the whole point of a reachable service.
  if (!network) throw new Error("buildResourceServiceSpec: network is required");
  if (network === "host" || network === "none") {
    throw new Error(
      `buildResourceServiceSpec: network must be a named internal network, not '${network}'`,
    );
  }

  // Relaxation guard 3: a stable, namespaced, dns-safe name.
  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new Error(
      `buildResourceServiceSpec: name must match ${SERVICE_NAME_PATTERN.source}`,
    );
  }

  // Relaxation guard 2: the env allowlist + secret guard. Throws a
  // ServiceEnvViolation (key + reason only, never the value) on any violation.
  const env = buildServiceEnv(opts.env);

  const spec: ResourceServiceSpec = {
    image,
    runtime: runtimeFor(backend),
    network,
    readonlyRootfs: true,
    tmpfs: hardenTmpfs(opts.tmpfs ?? DEFAULT_TMPFS),
    capDrop: ["ALL"] as const,
    capAdd: [] as const,
    securityOpt: ["no-new-privileges:true"] as const,
    pidsLimit: limits.pidsLimit,
    memoryBytes: limits.memoryBytes,
    cpus: limits.cpus,
    ...(limits.storageOptSize !== undefined ? { storageOptSize: limits.storageOptSize } : {}),
    env,
    name,
    restartPolicy: opts.restartPolicy ?? DEFAULT_SERVICE_RESTART_POLICY,
    port,
    // Labels are non-secret operator metadata (resourceId/slug), so no secret guard
    // is applied here - they are not handler-supplied env.
    ...(opts.labels ? { labels: opts.labels } : {}),
    // NOTE: no timeoutSeconds - a service is long-lived and never auto-killed.
  };

  return spec;
}
