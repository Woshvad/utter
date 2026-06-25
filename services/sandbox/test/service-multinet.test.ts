// service-multinet.test.ts - the runner-side post-create multi-network attach
// (quick 260625-9dc). NO live daemon: a minimal dockerode stub records the call
// ORDER so we can assert the launch sequence is create -> connect each extra net
// -> start (extras attached BEFORE start), each extra connected exactly once, and
// that a failing connect surfaces a start-service RunError, force-removes the
// half-created container, and rethrows (no leaked container).
import { describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";
import { GvisorRunner } from "../src/runner/gvisor";
import { DockerDevRunner } from "../src/runner/docker-dev";
import { buildResourceServiceSpec } from "../src/runner/service-runspec";
import type { RunBackend, RunError } from "../src/runner/types";

const LIMITS = {
  pidsLimit: 128,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 0.5,
};

// Build a real hardened spec (so the runtime matches the backend) with two extra
// nets. `runtime` is derived by the builder: runsc for gvisor, runc for docker-dev.
const specFor = (backend: RunBackend) =>
  buildResourceServiceSpec({
    backend,
    image: "resource:abc123",
    limits: LIMITS,
    network: "ingress",
    extraNetworks: ["controlplane", "proxynet"],
    env: { PORT: "8080" },
    name: "utter_res_sidecar-1",
    port: 8080,
  });

/**
 * A minimal dockerode stub that records an ordered call log. `createContainer`
 * returns a fake container with a stubbed `start`; `getNetwork(name)` returns a
 * `connect` stub; `getContainer(id)` returns a `remove` stub. `failConnectOn`
 * makes that net's connect reject so we can drive the cleanup path.
 */
function makeDockerStub(opts: { failConnectOn?: string } = {}) {
  const calls: string[] = [];
  const containerId = "container-xyz";

  const start = vi.fn(async () => {
    calls.push("start");
  });
  const remove = vi.fn(async () => {
    calls.push("remove");
  });

  const createContainer = vi.fn(async () => {
    calls.push("create");
    return { id: containerId, start } as unknown as Docker.Container;
  });

  const connectsByNet: Record<string, ReturnType<typeof vi.fn>> = {};
  const getNetwork = vi.fn((name: string) => {
    const connect = vi.fn(async () => {
      calls.push(`connect:${name}`);
      if (opts.failConnectOn === name) {
        throw new Error(`network ${name} connect failed`);
      }
    });
    connectsByNet[name] = connect;
    return { connect } as unknown as Docker.Network;
  });

  const getContainer = vi.fn((_id: string) => ({ remove }) as unknown as Docker.Container);

  const docker = { createContainer, getNetwork, getContainer } as unknown as Docker;
  return { docker, calls, createContainer, getNetwork, getContainer, start, remove, containerId };
}

const runnerFor = (backend: RunBackend, docker: Docker, onError: (e: RunError) => void) =>
  backend === "gvisor" ? new GvisorRunner(docker, onError) : new DockerDevRunner(docker, onError);

describe("startService - post-create multi-network attach", () => {
  for (const backend of ["gvisor", "docker-dev"] as const) {
    describe(backend, () => {
      it("creates, connects each extra net BEFORE start, exactly once, in order", async () => {
        const stub = makeDockerStub();
        const runner = runnerFor(backend, stub.docker, () => {});

        const handle = await runner.startService(specFor(backend));

        // The order: create, then both extra connects, then start.
        expect(stub.calls).toEqual([
          "create",
          "connect:controlplane",
          "connect:proxynet",
          "start",
        ]);
        // Each extra net connected exactly once with the created container id.
        expect(stub.getNetwork).toHaveBeenCalledWith("controlplane");
        expect(stub.getNetwork).toHaveBeenCalledWith("proxynet");
        expect(stub.createContainer).toHaveBeenCalledTimes(1);
        expect(stub.start).toHaveBeenCalledTimes(1);
        // The primary network is NOT re-connected (it is the create-time NetworkMode).
        expect(stub.getNetwork).not.toHaveBeenCalledWith("ingress");
        expect(handle.id).toBe(stub.containerId);
      });

      it("a failing connect surfaces a start-service RunError, force-removes, and rethrows", async () => {
        const stub = makeDockerStub({ failConnectOn: "proxynet" });
        const errors: RunError[] = [];
        const runner = runnerFor(backend, stub.docker, (e) => errors.push(e));

        await expect(runner.startService(specFor(backend))).rejects.toThrow(/proxynet/);

        // start was NEVER reached (the connect failed before start).
        expect(stub.start).not.toHaveBeenCalled();
        // The half-created container was force-removed (no leak).
        expect(stub.getContainer).toHaveBeenCalledWith(stub.containerId);
        expect(stub.remove).toHaveBeenCalledWith({ force: true });
        // The RunError was surfaced with the created container id (not the name).
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ phase: "start-service", id: stub.containerId });
        // Order: create -> connect:controlplane -> connect:proxynet (fails) -> remove.
        expect(stub.calls).toEqual([
          "create",
          "connect:controlplane",
          "connect:proxynet",
          "remove",
        ]);
      });
    });
  }

  it("a spec with no extraNetworks does create -> start with no connect (no regression)", async () => {
    const stub = makeDockerStub();
    const runner = new GvisorRunner(stub.docker, () => {});
    const spec = buildResourceServiceSpec({
      backend: "gvisor",
      image: "resource:abc123",
      limits: LIMITS,
      network: "ingress",
      env: { PORT: "8080" },
      name: "utter_res_solo-1",
      port: 8080,
    });

    await runner.startService(spec);

    expect(stub.calls).toEqual(["create", "start"]);
    expect(stub.getNetwork).not.toHaveBeenCalled();
    expect(stub.remove).not.toHaveBeenCalled();
  });
});
