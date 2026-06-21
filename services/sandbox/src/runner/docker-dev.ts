// docker-dev backend - PLAIN DOCKER IS NOT A SECURITY BOUNDARY.
//
// !!! READ THIS BEFORE USING THIS FILE !!!
// This backend runs an untrusted handler container under plain Docker / Docker
// Desktop (runtime "runc"). Plain Docker shares the host kernel: a container
// escape from a kernel-level exploit is NOT contained. This backend exists for
// LOCAL WIRING + INTEGRATION TESTS ONLY. It MUST NEVER satisfy a security
// acceptance (SBX-01/02/06) and MUST NEVER be presented as an isolation
// boundary (CLAUDE.md, SPEC §9.5). The ONLY trusted boundary is the `gvisor`
// backend (runtime "runsc") on the operator-provisioned host, verified in the
// operator-gated Plan 06 acceptance.
//
// It is given the IDENTICAL hardened RunSpec the gvisor backend gets (read-only
// root, cap-drop ALL, no-new-privileges, pids/mem/cpu, empty env) so the wiring
// is faithful - but faithful wiring is not containment. The runner enforces the
// execution timeout by killing the container at `spec.timeoutSeconds`.
import type Docker from "dockerode";
import { toDockerodeCreateOptions } from "./dockerode-spec";
import { demuxDockerLogs } from "./demux";
import type { RunErrorSink, RunHandle, RunInspect, RunLogs, RunSpec, SandboxRunner } from "./types";

/**
 * The local, NON-SECURITY-BOUNDARY runner. Wraps dockerode with the hardened
 * create-spec + a runner-enforced kill timeout. Use ONLY for local wiring and
 * integration tests; never for a security acceptance.
 */
export class DockerDevRunner implements SandboxRunner {
  readonly backend = "docker-dev" as const;
  private readonly docker: Docker;
  private readonly onError: RunErrorSink;

  constructor(docker: Docker, onError?: RunErrorSink) {
    this.docker = docker;
    // A failed timeout-kill means an untrusted, possibly over-budget container kept
    // running past its deadline — surface it, never swallow (WR-06). Default sink is
    // a non-secret console.warn (id + message only).
    this.onError = onError ?? ((e) => console.warn(`[docker-dev] ${e.phase} failed container=${e.id}: ${e.message}`));
  }

  async run(spec: RunSpec): Promise<RunHandle> {
    if (spec.runtime !== "runc") {
      // docker-dev is runc by construction; runsc belongs to the gvisor backend.
      throw new Error("DockerDevRunner requires a runc run-spec (use the gvisor backend for runsc)");
    }
    const container = await this.docker.createContainer(toDockerodeCreateOptions(spec));
    await container.start();

    // Runner-enforced timeout: kill the container at the deadline (SBX-04). A failed
    // kill is surfaced (WR-06) — it means the deadline was NOT enforced.
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

  async stop(id: string): Promise<void> {
    // A failed stop is surfaced (WR-06): a still-running untrusted container is a
    // security-relevant event. Swallow the rejection so stop() stays idempotent,
    // but never silently.
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
