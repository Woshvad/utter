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
import type { RunHandle, RunInspect, RunLogs, RunSpec, SandboxRunner } from "./types";

/**
 * The local, NON-SECURITY-BOUNDARY runner. Wraps dockerode with the hardened
 * create-spec + a runner-enforced kill timeout. Use ONLY for local wiring and
 * integration tests; never for a security acceptance.
 */
export class DockerDevRunner implements SandboxRunner {
  readonly backend = "docker-dev" as const;

  constructor(private readonly docker: Docker) {}

  async run(spec: RunSpec): Promise<RunHandle> {
    if (spec.runtime !== "runc") {
      // docker-dev is runc by construction; runsc belongs to the gvisor backend.
      throw new Error("DockerDevRunner requires a runc run-spec (use the gvisor backend for runsc)");
    }
    const container = await this.docker.createContainer(toDockerodeCreateOptions(spec));
    await container.start();

    // Runner-enforced timeout: kill the container at the deadline (SBX-04).
    const deadline = setTimeout(() => {
      void container.kill().catch(() => undefined);
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
    await this.docker.getContainer(id).kill().catch(() => undefined);
  }

  async logs(id: string): Promise<RunLogs> {
    const buf = (await this.docker.getContainer(id).logs({
      stdout: true,
      stderr: true,
    })) as unknown as Buffer;
    // Plain (non-demuxed) capture is enough for the dev/test path.
    return { stdout: buf.toString("utf8"), stderr: "" };
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
