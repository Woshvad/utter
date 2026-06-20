// buildRunSpec - the PURE hardened run-spec builder (SBX-01/04; RESEARCH
// Pattern 1, Code Examples §1).
//
// This function maps a backend + image + resource limits into the fully-
// resolved `RunSpec` the runner launches. It is the single place every
// security-relevant flag is set, so the invariant test (runspec.test.ts) can
// assert - with NO container launch - that the spec NEVER carries
// `privileged:true`, `network:"host"`, any `capAdd`, or a non-empty `env`, for
// BOTH backends. The only difference between backends is the runtime:
//   - gvisor     -> runsc  (the trusted boundary on the provisioned host)
//   - docker-dev -> runc   (plain Docker; NOT a security boundary, identical
//                           hardening flags so the wiring is faithful)
//
// The execution timeout is RUNNER-enforced: `timeoutSeconds` is carried here and
// the backend kills the container at the deadline. The `--storage-opt size=`
// disk quota is carried but its real enforcement is OPERATOR-GATED (needs
// overlay2 + xfs pquota; RESEARCH Pitfall 4) - memory/PID/CPU/timeout + the HARD
// size cap (size-cap.ts) are the locally-enforced limits.
import type { RunBackend, RunSpec } from "./types";

/** Resource limits for one sandboxed run (all positive). */
export interface RunLimits {
  /** Hard process cap (--pids-limit). */
  pidsLimit: number;
  /** Memory cap in bytes (--memory). */
  memoryBytes: number;
  /** CPU cap (--cpus). */
  cpus: number;
  /**
   * Optional disk quota (--storage-opt size=...). OPERATOR-GATED enforcement
   * (overlay2 + xfs pquota); omit to leave the flag unset.
   */
  storageOptSize?: string;
}

/** Inputs to `buildRunSpec`. */
export interface BuildRunSpecOptions {
  /** gvisor (runsc) or docker-dev (runc, NOT a boundary). */
  backend: RunBackend;
  /** The resource image to launch. */
  image: string;
  /** The resource resource limits. */
  limits: RunLimits;
  /** The hard execution timeout in seconds (= maxTimeoutSeconds, runner-enforced). */
  maxTimeoutSeconds: number;
  /**
   * Optional tmpfs mounts (the only writable paths). Defaults to a single small
   * /tmp mounted noexec,nosuid. Every mount is forced noexec,nosuid below.
   */
  tmpfs?: Record<string, string>;
}

/** Map a backend to its container runtime. gvisor -> runsc; docker-dev -> runc. */
function runtimeFor(backend: RunBackend): "runsc" | "runc" {
  return backend === "gvisor" ? "runsc" : "runc";
}

/** The default tmpfs: a small, non-executable /tmp. */
const DEFAULT_TMPFS: Record<string, string> = {
  "/tmp": "rw,noexec,nosuid,size=16m",
};

/** Force every tmpfs option string to include noexec,nosuid (defense in depth). */
function hardenTmpfs(tmpfs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, opts] of Object.entries(tmpfs)) {
    const parts = new Set(
      opts
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    );
    parts.add("noexec");
    parts.add("nosuid");
    out[path] = [...parts].join(",");
  }
  return out;
}

/**
 * Build the hardened run-spec for one untrusted handler container.
 *
 * Security invariants this function guarantees (asserted in runspec.test.ts for
 * BOTH backends): the result NEVER has `privileged:true`, NEVER has
 * `network:"host"`, NEVER has any `capAdd`, and its `env` is exactly empty. The
 * gvisor backend always yields `runtime:"runsc"`.
 *
 * @throws if any limit or the timeout is non-positive (a misconfiguration that
 *         would weaken the sandbox).
 */
export function buildRunSpec(opts: BuildRunSpecOptions): RunSpec {
  const { backend, image, limits, maxTimeoutSeconds } = opts;

  if (!image) throw new Error("buildRunSpec: image is required");
  if (limits.pidsLimit <= 0) throw new Error("buildRunSpec: pidsLimit must be > 0");
  if (limits.memoryBytes <= 0) throw new Error("buildRunSpec: memoryBytes must be > 0");
  if (limits.cpus <= 0) throw new Error("buildRunSpec: cpus must be > 0");
  if (maxTimeoutSeconds <= 0) {
    throw new Error("buildRunSpec: maxTimeoutSeconds must be > 0");
  }

  const spec: RunSpec = {
    image,
    runtime: runtimeFor(backend),
    // "none": no default route. The egress firewall attaches the only path
    // (the data-proxy) host-side. NEVER "host".
    network: "none",
    readonlyRootfs: true,
    tmpfs: hardenTmpfs(opts.tmpfs ?? DEFAULT_TMPFS),
    capDrop: ["ALL"] as const,
    // Explicitly empty: the invariant forbids ANY capAdd.
    capAdd: [] as const,
    securityOpt: ["no-new-privileges:true"] as const,
    pidsLimit: limits.pidsLimit,
    memoryBytes: limits.memoryBytes,
    cpus: limits.cpus,
    // OPERATOR-GATED disk quota (overlay2 + xfs pquota; RESEARCH Pitfall 4).
    ...(limits.storageOptSize !== undefined ? { storageOptSize: limits.storageOptSize } : {}),
    timeoutSeconds: maxTimeoutSeconds,
    // SBX-03: exactly empty. No platform env, no keys - only the data-proxy's
    // short-lived scoped token is injected at request time, never here.
    env: {},
  };

  return spec;
}
