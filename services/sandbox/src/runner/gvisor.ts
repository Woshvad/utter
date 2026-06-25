// gvisor backend - the TRUSTED isolation boundary (runtime "runsc").
//
// This backend launches an untrusted handler container under gVisor (runsc) on
// the operator-provisioned host. gVisor's userspace kernel (sentry) intercepts
// guest syscalls, so a kernel-level container escape is contained - this is the
// ONLY trusted security boundary (CLAUDE.md, SPEC §9.5). Its live acceptance
// (malicious-probe-blocked, runsc-enforced limits) is OPERATOR-GATED in Plan 06:
// runsc must be registered in the host's /etc/docker/daemon.json and the host
// firewall must enforce default-deny egress. Running this against plain Docker
// (no runsc runtime) fails fast at create time - it never silently degrades to
// a non-boundary.
//
// The backend shares the hardened create-spec translator with docker-dev; the
// ONLY difference is `Runtime:"runsc"`. The runner enforces the execution
// timeout by killing the container at `spec.timeoutSeconds`.
import type Docker from "dockerode";
import { toDockerodeCreateOptions } from "./dockerode-spec";
import { toServiceDockerodeCreateOptions } from "./service-dockerode-spec";
import { demuxDockerLogs } from "./demux";
import type {
  ResourceServiceSpec,
  RunErrorSink,
  RunHandle,
  RunInspect,
  RunLogs,
  RunSpec,
  SandboxRunner,
  ServiceHandle,
} from "./types";

/**
 * The trusted isolation runner (runtime runsc). Operator-gated: requires runsc
 * registered on the host. Wraps dockerode with the hardened create-spec + a
 * runner-enforced kill timeout.
 */
export class GvisorRunner implements SandboxRunner {
  readonly backend = "gvisor" as const;
  private readonly docker: Docker;
  private readonly onError: RunErrorSink;

  constructor(docker: Docker, onError?: RunErrorSink) {
    this.docker = docker;
    // On the trusted boundary a failed timeout-kill is especially important: it
    // means an untrusted container ran past its enforced deadline. Surface it,
    // never swallow (WR-06). Default sink is a non-secret console.warn.
    this.onError = onError ?? ((e) => console.warn(`[gvisor] ${e.phase} failed container=${e.id}: ${e.message}`));
  }

  async run(spec: RunSpec): Promise<RunHandle> {
    if (spec.runtime !== "runsc") {
      // The gvisor backend is runsc by construction. A non-runsc spec here is a
      // misconfiguration that would silently drop the boundary - fail fast.
      throw new Error(
        "GvisorRunner requires a runsc run-spec - refusing to run an untrusted bundle without gVisor",
      );
    }
    const container = await this.docker.createContainer(toDockerodeCreateOptions(spec));
    await container.start();

    const deadline = setTimeout(() => {
      void container.kill().catch((err) => {
        this.onError({
          phase: "timeout-kill",
          id: container.id,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }, spec.timeoutSeconds * 1000);

    return {
      id: container.id,
      backend: this.backend,
      wait: async () => {
        try {
          const { StatusCode } = await container.wait();
          return StatusCode;
        } finally {
          clearTimeout(deadline);
        }
      },
    };
  }

  /**
   * Launch a long-lived resource-service container under gVisor (runsc).
   * Detached: it creates -> starts -> returns a `ServiceHandle` and installs NO
   * setTimeout deadline (a service is not auto-killed). The runsc-or-refuse
   * guard is the same as `run`: a non-runsc spec would silently drop the
   * boundary, so fail fast. A failed start surfaces through the RunError sink
   * (phase "start-service"), never swallowed.
   */
  async startService(spec: ResourceServiceSpec): Promise<ServiceHandle> {
    if (spec.runtime !== "runsc") {
      throw new Error(
        "GvisorRunner requires a runsc service-spec - refusing to start an untrusted service without gVisor",
      );
    }

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(toServiceDockerodeCreateOptions(spec));
      await container.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface the failed start (WR-06). The id may be absent if create failed;
      // fall back to the service name (non-secret) for traceability.
      this.onError({ phase: "start-service", id: spec.name, message });
      throw err instanceof Error ? err : new Error(message);
    }

    // No deadline timer: a long-lived service is never auto-killed.
    return {
      id: container.id,
      backend: this.backend,
      stop: () => this.stop(container.id),
    };
  }

  async stop(id: string): Promise<void> {
    await this.docker.getContainer(id).kill().catch((err) => {
      this.onError({
        phase: "stop",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async logs(id: string): Promise<RunLogs> {
    const buf = (await this.docker.getContainer(id).logs({
      stdout: true,
      stderr: true,
    })) as unknown as Buffer;
    // Demultiplex Docker's multiplexed frame stream so stdout/stderr are separated
    // and frame headers stripped (WR-05) — stderr classification depends on it.
    return demuxDockerLogs(buf);
  }

  async inspect(id: string): Promise<RunInspect> {
    const info = await this.docker.getContainer(id).inspect();
    return {
      id,
      running: info.State.Running ?? false,
      exitCode: info.State.ExitCode ?? null,
    };
  }
}
