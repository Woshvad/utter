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
import type { RunHandle, RunInspect, RunLogs, RunSpec, SandboxRunner } from "./types";

/**
 * The trusted isolation runner (runtime runsc). Operator-gated: requires runsc
 * registered on the host. Wraps dockerode with the hardened create-spec + a
 * runner-enforced kill timeout.
 */
export class GvisorRunner implements SandboxRunner {
  readonly backend = "gvisor" as const;

  constructor(private readonly docker: Docker) {}

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
