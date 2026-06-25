// SandboxRunner interface + the hardened RunSpec type (SBX-01/04; RESEARCH
// Pattern 1).
//
// A `RunSpec` is the pure, fully-resolved description of how ONE untrusted
// handler container is launched. It is produced by `buildRunSpec` (runspec.ts)
// and consumed by a `SandboxRunner` backend (gvisor.ts | docker-dev.ts) which
// translates it into a dockerode create-spec. Keeping the spec a plain data
// object lets the security-relevant invariants (never --privileged, never
// host-net, cap-drop ALL, empty env) be unit-asserted with NO container launch.
//
// SECURITY BOUNDARY NOTE: only the `gvisor` backend (runtime "runsc" on the
// operator-provisioned host) is a trusted isolation boundary. The `docker-dev`
// backend (runtime "runc", plain Docker / Docker Desktop) is wiring +
// integration-test scaffolding ONLY and is NEVER a security boundary
// (CLAUDE.md, SPEC §9.5). It is given the IDENTICAL hardening flags so the
// wiring is faithful, but it must never satisfy a security acceptance.

/** Which isolation backend a run targets. `docker-dev` is NOT a security boundary. */
export type RunBackend = "gvisor" | "docker-dev";

/**
 * The container runtime a backend maps to. `runsc` is gVisor (the trusted
 * boundary on the provisioned host); `runc` is plain Docker (docker-dev only).
 */
export type ContainerRuntime = "runsc" | "runc";

/**
 * The fully-resolved, hardened launch spec for one untrusted handler container.
 *
 * Every security-relevant field is a fixed literal so the invariant test can
 * assert the spec NEVER carries `privileged:true`, `network:"host"`, any
 * `capAdd`, or a non-empty `env`. The shape mirrors RESEARCH Pattern 1.
 */
export interface RunSpec {
  /** The resource image to run (tagged by resourceId+version upstream). */
  image: string;
  /** runsc (gvisor backend) or runc (docker-dev backend, NOT a boundary). */
  runtime: ContainerRuntime;
  /**
   * The container network. Default "none": the container starts with NO route;
   * the egress firewall (egress/firewall.ts) attaches the only path (the
   * data-proxy) host-side. Never "host" (the invariant forbids it).
   */
  network: "none" | string;
  /** Read-only root filesystem. Always true (SBX-04). */
  readonlyRootfs: true;
  /**
   * The only writable mounts: small tmpfs(es) mounted noexec,nosuid. e.g.
   * `{ "/tmp": "rw,noexec,nosuid,size=16m" }`.
   */
  tmpfs: Record<string, string>;
  /** Linux capabilities dropped. Always exactly ["ALL"] (SBX-01). */
  capDrop: readonly ["ALL"];
  /**
   * Capabilities added back. ALWAYS empty (the invariant forbids any capAdd) —
   * present as an explicit empty list so the assertion is unambiguous.
   */
  capAdd: readonly [];
  /** no-new-privileges so a setuid binary cannot escalate (SBX-01). */
  securityOpt: readonly ["no-new-privileges:true"];
  /** Hard process cap (--pids-limit), e.g. 128. Positive (SBX-04). */
  pidsLimit: number;
  /** Memory cap in bytes (--memory). Positive (SBX-04). */
  memoryBytes: number;
  /** CPU cap (--cpus), e.g. 0.5. Positive (SBX-04). */
  cpus: number;
  /**
   * Disk quota (--storage-opt size=...). OPERATOR-GATED: real enforcement needs
   * a quota-capable storage driver/FS (overlay2 + xfs pquota — RESEARCH
   * Pitfall 4); on Docker Desktop's WSL2 disk it may be a no-op. Present in the
   * spec, but disk-quota enforcement is host-verified, never assumed locally.
   */
  storageOptSize?: string;
  /**
   * Hard execution timeout in seconds (= maxTimeoutSeconds). RUNNER-enforced:
   * the backend kills the container at this deadline (SBX-04 timeout clause).
   */
  timeoutSeconds: number;
  /**
   * The container environment. MUST be exactly empty (SBX-03): no platform env,
   * no wallet/upstream keys — the data-proxy injects only a short-lived scoped
   * token at request time. Typed `Record<string, never>` so any key is a type
   * error.
   */
  env: Record<string, never>;
}

/**
 * The restart policy for a long-lived resource-service container.
 *
 * Default is `on-failure` with a max-retry cap (security review H4): an
 * untrusted handler that crashes must NOT restart-loop forever and burn the
 * host. `unless-stopped` is permitted but not the default; `no` disables
 * restart entirely. `name` matches dockerode's `HostRestartPolicy.Name`.
 */
export interface ServiceRestartPolicy {
  /** dockerode restart name: "on-failure" (default), "unless-stopped", or "no". */
  name: "on-failure" | "unless-stopped" | "no";
  /**
   * Max retry count for "on-failure" (the H4 cap). Positive for "on-failure";
   * ignored by Docker for the other names. Present so a crashing untrusted
   * handler cannot restart-loop without bound.
   */
  maxRetryCount?: number;
}

/**
 * The fully-resolved, hardened launch spec for ONE long-lived resource-service
 * container (the additive sibling of `RunSpec`).
 *
 * It mirrors `RunSpec`'s isolation fields with the IDENTICAL literal types
 * (runsc/runc, readonly root, capDrop ALL, capAdd [], no-new-privileges,
 * pids/mem/cpu, hardened tmpfs) so an invariant test can assert the isolation
 * surface is unchanged. It relaxes ONLY four deployment fields: a named
 * `network` (never "host"/"none"), a secret-guarded `env` allowlist, a stable
 * `name`, and a `restartPolicy`.
 *
 * CRITICAL: there is deliberately NO `timeoutSeconds` field. The "does not
 * auto-kill" property of a long-lived service is enforced by ABSENCE, so no
 * future edit can flip a flag to re-enable the deadline kill without re-adding
 * the field (and tripping review).
 */
export interface ResourceServiceSpec {
  /** The resource image to run as a long-lived service. */
  image: string;
  /** runsc (gvisor backend) or runc (docker-dev backend, NOT a boundary). */
  runtime: ContainerRuntime;
  /**
   * A NAMED internal Docker network the service joins (Traefik reaches it by
   * name; it reaches the facilitator over the control plane). Never "host" and
   * never "none" — the builder rejects both. The internal network has no
   * default gateway, so reachability is named-peer, NOT internet egress.
   */
  network: string;
  /** Read-only root filesystem. Always true (identical to RunSpec). */
  readonlyRootfs: true;
  /** The only writable mounts: small tmpfs(es) mounted noexec,nosuid. */
  tmpfs: Record<string, string>;
  /** Linux capabilities dropped. Always exactly ["ALL"] (identical to RunSpec). */
  capDrop: readonly ["ALL"];
  /** Capabilities added back. ALWAYS empty — the relaxation buys back no capability. */
  capAdd: readonly [];
  /** no-new-privileges (identical to RunSpec). */
  securityOpt: readonly ["no-new-privileges:true"];
  /** Hard process cap (--pids-limit). Positive. */
  pidsLimit: number;
  /** Memory cap in bytes (--memory). Positive. */
  memoryBytes: number;
  /** CPU cap (--cpus). Positive. */
  cpus: number;
  /** OPERATOR-GATED disk quota (--storage-opt size=...); same gating as RunSpec. */
  storageOptSize?: string;
  /**
   * The secret-guarded non-secret config map (validated by buildServiceEnv):
   * only the public routing/identity/pricing allowlist, never a key or token.
   * Replaces RunSpec's `env:{}` — config identifiers are not secrets.
   */
  env: Record<string, string>;
  /** A stable, namespaced container name matching `^utter_res_[a-z0-9-]+$`. */
  name: string;
  /** The restart policy (default on-failure + max-retry cap per review H4). */
  restartPolicy: ServiceRestartPolicy;
  /** The container port Traefik routes to (the service's listen port). */
  port: number;
}

/**
 * A handle to a launched long-lived service, returned by
 * `SandboxRunner.startService`. Unlike `RunHandle` it has NO `wait()` — a
 * service is detached and not awaited to an exit code — and the runner installs
 * NO deadline timer.
 */
export interface ServiceHandle {
  /** The backend's container id for this service. */
  id: string;
  /** Which backend launched it (`docker-dev` is NOT a boundary). */
  backend: RunBackend;
  /** Stop (kill + remove) the service. Idempotent. */
  stop(): Promise<void>;
}

/** A handle to a launched run, returned by `SandboxRunner.run`. */
export interface RunHandle {
  /** The backend's container id for this run. */
  id: string;
  /** Which backend launched it (`docker-dev` is NOT a boundary). */
  backend: RunBackend;
  /** Wait for the run to exit (or be killed at the timeout). Resolves the exit code. */
  wait(): Promise<number>;
}

/** Captured stdout/stderr from a run. */
export interface RunLogs {
  stdout: string;
  stderr: string;
}

/**
 * A surfaced runner enforcement failure (WR-06). A failed timeout-kill or stop
 * means an untrusted container kept running past its deadline — a
 * security-relevant event that must be visible, not swallowed. NEVER carries
 * secret material (only the container id + a phase + an error message).
 */
export interface RunError {
  /** Which enforcement action failed. */
  phase: "timeout-kill" | "stop" | "start-service";
  /** The container id involved. */
  id: string;
  /** The error message (no secrets). */
  message: string;
}

/** The error sink a runner calls when an enforcement action fails (WR-06). */
export type RunErrorSink = (error: RunError) => void;

/** Backend-reported inspection of a launched container. */
export interface RunInspect {
  id: string;
  running: boolean;
  exitCode: number | null;
}

/**
 * The pluggable isolation runner. Two backends implement it: `gvisor` (the
 * trusted boundary, runtime runsc, operator host) and `docker-dev` (runtime
 * runc, NOT a security boundary — local wiring + integration tests only). The
 * interface is identical so the autonomous suite exercises the same contract
 * with no isolation host (mirrors the Phase 2 PaymentStore adapter pattern).
 */
export interface SandboxRunner {
  /** Which backend this runner is. */
  readonly backend: RunBackend;
  /** Launch a container from a hardened RunSpec; the runner enforces the timeout (kill). */
  run(spec: RunSpec): Promise<RunHandle>;
  /**
   * OPTIONAL: launch a long-lived resource-service container from a hardened
   * `ResourceServiceSpec`. Detached: it creates -> starts -> returns a
   * `ServiceHandle` with NO deadline timer (a service is not auto-killed). A
   * failed start surfaces through the `RunError` sink (phase "start-service").
   * Optional so a backend may omit it; both shipped backends implement it.
   */
  startService?(spec: ResourceServiceSpec): Promise<ServiceHandle>;
  /** Stop (kill) a running container by id. Idempotent. */
  stop(id: string): Promise<void>;
  /** Fetch captured stdout/stderr for a run. */
  logs(id: string): Promise<RunLogs>;
  /** Inspect a run's current state. */
  inspect(id: string): Promise<RunInspect>;
}
