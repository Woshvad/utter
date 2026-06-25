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
 * Reject any non-named network: empty, "host" (a forbidden isolation break), or
 * "none" (defeats a reachable service). Shared by the primary `network` guard and
 * each `extraNetworks` entry so they validate identically. `field` names the
 * offending option in the error.
 */
function assertNamedNetwork(value: string, field: string): void {
  if (!value) throw new Error(`buildResourceServiceSpec: ${field} is required`);
  if (value === "host" || value === "none") {
    throw new Error(
      `buildResourceServiceSpec: ${field} must be a named internal network, not '${value}'`,
    );
  }
}

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
  /**
   * Optional ADDITIONAL named internal networks the service joins after the
   * primary `network` (a post-create connect per extra; see the runner). Each is
   * validated by the SAME guard the primary uses: non-empty, never "host"/"none",
   * and never equal to the primary `network` (a duplicate). Used for the sidecar's
   * ingress(primary)+controlplane+proxynet membership. Absent leaves the
   * single-network behavior unchanged.
   */
  extraNetworks?: string[];
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
 * Internal: run EVERY shared validation and assemble the hardened service spec
 * literal from the `env` it is HANDED. This is the single source of the
 * isolation surface (runtime, readonly root, hardened tmpfs, capDrop ALL,
 * capAdd [], no-new-privileges, pids/mem/cpu, storageOptSize, name pattern,
 * restartPolicy default, port, extraNetworks). Both the untrusted and the
 * trusted public builders call this with the SAME options; they differ ONLY in
 * how `env` is admitted before it is passed in (the untrusted path runs the
 * secret guard, the trusted path does not). It is deliberately NOT exported -
 * callers must go through a public builder so the env-admission decision is
 * always explicit.
 *
 * @throws if a limit or the port is non-positive, the image is missing, the
 *         name does not match SERVICE_NAME_PATTERN, the network is "host"/"none"
 *         or empty, or an extra network is invalid/duplicate.
 */
function assembleServiceSpec(
  opts: BuildResourceServiceSpecOptions,
  env: Record<string, string>,
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
  assertNamedNetwork(network, "network");

  // Relaxation guard 1b: each extra net is validated by the SAME named-network
  // guard, and must not duplicate the primary. Extras are attached post-create
  // by the runner (create -> connect each -> start); they are connect-only and
  // do NOT change the primary NetworkMode.
  for (const extra of opts.extraNetworks ?? []) {
    assertNamedNetwork(extra, "extraNetworks");
    if (extra === network) {
      throw new Error(
        `buildResourceServiceSpec: extraNetworks must not duplicate the primary network '${network}'`,
      );
    }
  }

  // Relaxation guard 3: a stable, namespaced, dns-safe name.
  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new Error(
      `buildResourceServiceSpec: name must match ${SERVICE_NAME_PATTERN.source}`,
    );
  }

  const spec: ResourceServiceSpec = {
    image,
    runtime: runtimeFor(backend),
    network,
    // Extras are connect-only (attached post-create, before start by the runner);
    // the primary `network` is unchanged. Carried as a readonly copy, omitted when
    // absent so the single-network spec is isolation-identical.
    ...(opts.extraNetworks?.length ? { extraNetworks: [...opts.extraNetworks] } : {}),
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

/**
 * Build the hardened spec for one long-lived resource-service container.
 *
 * Isolation invariants (asserted in service-runspec.test.ts, identical to the
 * one-shot spec): runtime runsc for gvisor, readonlyRootfs true, capDrop ALL,
 * capAdd [], no-new-privileges, positive pids/mem/cpu, hardened tmpfs. The four
 * relaxed fields are validated here.
 *
 * This is the UNTRUSTED path: it runs the env secret-guard (`buildServiceEnv`),
 * so it admits ONLY the non-secret config allowlist and rejects any secret- or
 * token-shaped env. Use this for AI-generated/untrusted resource handlers.
 *
 * @throws if a limit or the port is non-positive, the image is missing, the
 *         name does not match SERVICE_NAME_PATTERN, the network is "host"/"none"
 *         or empty, or buildServiceEnv rejects the env.
 */
export function buildResourceServiceSpec(
  opts: BuildResourceServiceSpecOptions,
): ResourceServiceSpec {
  // Relaxation guard 2: the env allowlist + secret guard. Throws a
  // ServiceEnvViolation (key + reason only, never the value) on any violation.
  // The untrusted path ALWAYS runs this guard - it is the only difference from
  // buildTrustedServiceSpec.
  return assembleServiceSpec(opts, buildServiceEnv(opts.env));
}

/**
 * !! TRUSTED-ONLY BUILDER - FIRST-PARTY PLATFORM SIDECARS ONLY !!
 *
 * Build the hardened spec for one long-lived FIRST-PARTY service container whose
 * code WE author and audit (e.g. the per-resource escrow-gate sidecar). It is
 * byte-for-byte identical to buildResourceServiceSpec on EVERY isolation flag -
 * runsc/runtime, readonly root, hardened tmpfs, capDrop ALL, capAdd [],
 * no-new-privileges, pids/mem/cpu, storageOptSize, name pattern, restartPolicy,
 * port, extraNetworks, and all the network/name/limit validations - because both
 * builders share assembleServiceSpec. The ONLY difference is env admission: this
 * builder passes the raw env straight through WITHOUT the buildServiceEnv secret
 * guard, so a first-party sidecar may carry its own secret (e.g.
 * SIDECAR_FACILITATOR_TOKEN, the per-resource caller-auth token it presents to
 * the facilitator) plus its non-secret config (FACILITATOR_URL, HANDLER_URL,
 * CLASSIFIER_SCHEMA, etc).
 *
 * MUST NEVER be used to launch AI-generated or otherwise untrusted code. The
 * untrusted env secret-guard (the *_TOKEN / *_KEY / SECRET / PRIVATE denylist,
 * the value-shape rules, the entropy pass) exists precisely to stop untrusted
 * code from exfiltrating or smuggling a secret in its env. Bypassing it for
 * untrusted code would be a secret-leak / free-compute vector. The untrusted
 * path is buildResourceServiceSpec - use that for any handler we did not author.
 *
 * The isolation flags are NOT relaxed here; only the env admission differs
 * (trusted code may hold its own secret, untrusted code may not).
 *
 * @throws on the SAME non-env validations as buildResourceServiceSpec (a
 *         non-positive limit/port, a missing image, a bad name, a "host"/"none"
 *         or duplicate network). It does NOT run the env secret-guard.
 */
export function buildTrustedServiceSpec(
  opts: BuildResourceServiceSpecOptions,
): ResourceServiceSpec {
  // Trusted path: carry the raw env verbatim (a shallow copy so the caller's map
  // is not aliased). NO buildServiceEnv - a first-party sidecar may hold its own
  // secret. Every other field/validation is identical via assembleServiceSpec.
  return assembleServiceSpec(opts, { ...opts.env });
}
