// orchestrate.test.ts - the AUTONOMOUS deploy-orchestrator proofs (host phase H2).
//
// NO docker, NO chain. These assert the PURE pieces of the orchestrator: the echo
// env assembly + that it round-trips through buildResourceServiceSpec (proving the
// Task-1 allowlist reconciliation actually admits the echo env), the atomic Traefik
// route writer/remover into a vitest tmp dir, the host-gate of resolveDockerHandle,
// and waitForUnpaid402's poll/retry/timeout behaviour against a stubbed fetch. The
// docker-needing launch/reap paths are NOT exercised here (they need a live runsc).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import type { Hex } from "viem";
import type { Pricing } from "@utter/x402-arc";
import { buildResourceServiceSpec, SERVICE_NAME_PATTERN } from "@utter/sandbox";
import {
  buildEchoServiceEnv,
  buildHandlerServiceEnv,
  buildSidecarServiceEnv,
  pairNames,
  sidecarContainerUrl,
  launchResourcePair,
  reapResourcePair,
  writeTraefikDynamicFile,
  removeTraefikDynamicFile,
  resolveDockerHandle,
  resolveFacilitatorUrl,
  waitForUnpaid402,
  ECHO_SERVICE,
  RESOURCE_ID_LABEL,
  SLUG_LABEL,
  ROLE_LABEL,
  type DockerHandle,
} from "../src/orchestrate";
import { parseTraefikDynamicConfig } from "../src/traefik-config";

const RESOURCE_ID =
  "0x9a3c1f2e4b5d6c7a8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789ab" as Hex;
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

describe("buildEchoServiceEnv + buildResourceServiceSpec round-trip", () => {
  it("produces exactly the echo's env keys and they pass buildResourceServiceSpec", () => {
    const env = buildEchoServiceEnv({
      facilitatorUrl: "http://facilitator:8787",
      resourceId: RESOURCE_ID,
      cap: 10_000n,
      pricing: PRICING,
      maxTimeoutSeconds: 30,
      port: ECHO_SERVICE.port,
    });

    // Exactly the keys main.ts reads, with the documented pricing mapping.
    expect(env).toEqual({
      FACILITATOR_URL: "http://facilitator:8787",
      RESOURCE_ID: RESOURCE_ID,
      PORT: "8080",
      CAP: "10000",
      MAX_TIMEOUT_SECONDS: "30",
      PRICE_BASE: "5000",
      PRICE_PER_KB: "100",
      PRICE_MAX: "200",
    });

    // The allowlist reconciliation (Task 1) MUST admit this env: if any key were
    // missing from SERVICE_ENV_ALLOWLIST this throws a ServiceEnvViolation.
    const spec = buildResourceServiceSpec({
      backend: "gvisor",
      image: "utter-resource-echo:latest",
      limits: ECHO_SERVICE.limits,
      network: ECHO_SERVICE.network,
      env,
      name: ECHO_SERVICE.name,
      port: ECHO_SERVICE.port,
    });

    expect(spec.name).toBe("utter_res_echo");
    expect(spec.network).toBe("utter_appnet");
    expect(spec.runtime).toBe("runsc");
    expect(spec.port).toBe(8080);
    // The env round-trips through the allowlist + secret guard unchanged.
    expect(spec.env).toEqual(env);
  });
});

describe("writeTraefikDynamicFile / removeTraefikDynamicFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "utter-traefik-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a round-trippable route file whose loadBalancer url == the containerUrl", async () => {
    const path = await writeTraefikDynamicFile({
      slug: "echo",
      domain: "utter.technology",
      containerUrl: ECHO_SERVICE.containerUrl,
      dynamicDir: dir,
    });
    expect(path).toBe(join(dir, "echo.yml"));

    const yaml = await readFile(path, "utf8");
    const config = parseTraefikDynamicConfig(yaml);
    const router = config.http.routers.echo;
    const service = config.http.services.echo;
    expect(router).toBeDefined();
    expect(service).toBeDefined();
    expect(router!.rule).toBe("Host(`echo.resources.utter.technology`)");
    expect(service!.loadBalancer.servers[0]!.url).toBe(ECHO_SERVICE.containerUrl);
  });

  it("removeTraefikDynamicFile deletes the file and is a no-op when absent", async () => {
    const path = await writeTraefikDynamicFile({
      slug: "echo",
      domain: "utter.technology",
      containerUrl: ECHO_SERVICE.containerUrl,
      dynamicDir: dir,
    });
    await access(path); // present
    await removeTraefikDynamicFile("echo", dir);
    await expect(access(path)).rejects.toThrow(); // gone
    // A second remove on the already-absent file must not throw (ENOENT swallowed).
    await expect(removeTraefikDynamicFile("echo", dir)).resolves.toBeUndefined();
  });
});

describe("resolveDockerHandle host gate", () => {
  const saved = process.env.UTTER_SANDBOX_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.UTTER_SANDBOX_HOST;
    else process.env.UTTER_SANDBOX_HOST = saved;
  });

  it("returns undefined when UTTER_SANDBOX_HOST is unset", () => {
    delete process.env.UTTER_SANDBOX_HOST;
    expect(resolveDockerHandle()).toBeUndefined();
  });
});

describe("resolveFacilitatorUrl", () => {
  // A minimal docker stub: only getNetwork().inspect() is exercised. The Containers
  // map mirrors dockerode's NetworkInspectInfo shape (keyed by container id; each
  // value carries Name + IPv4Address with a /CIDR suffix). No real docker.
  function stubDocker(
    containers: Record<string, { Name: string; IPv4Address: string }>,
    capture?: (network: string) => void,
  ): DockerHandle {
    return {
      getNetwork(network: string) {
        capture?.(network);
        return {
          inspect: async () => ({ Containers: containers }),
        };
      },
    } as unknown as DockerHandle;
  }

  it("returns the facilitator IP:port, stripping the /CIDR suffix and defaulting port 8787", async () => {
    let inspected: string | undefined;
    const docker = stubDocker(
      {
        c1: { Name: "utter_facilitator_1", IPv4Address: "172.20.0.5/16" },
        c2: { Name: "utter_traefik_1", IPv4Address: "172.20.0.2/16" },
      },
      (n) => {
        inspected = n;
      },
    );

    const url = await resolveFacilitatorUrl(docker);
    expect(url).toBe("http://172.20.0.5:8787");
    // Defaults to the echo service's app network.
    expect(inspected).toBe(ECHO_SERVICE.network);
  });

  it("honors an explicit port override", async () => {
    const docker = stubDocker({
      c1: { Name: "facilitator", IPv4Address: "10.0.0.9/24" },
    });
    const url = await resolveFacilitatorUrl(docker, { port: 9999 });
    expect(url).toBe("http://10.0.0.9:9999");
  });

  it("throws when no facilitator container is attached to the network", async () => {
    const docker = stubDocker({
      c1: { Name: "utter_traefik_1", IPv4Address: "172.20.0.2/16" },
    });
    await expect(resolveFacilitatorUrl(docker)).rejects.toThrow(/no container matching/);
  });
});

describe("waitForUnpaid402", () => {
  it("returns immediately on a fetch that 402s", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("quote", { status: 402 });
    }) as unknown as typeof fetch;

    const res = await waitForUnpaid402("https://echo.example/echo", fetchImpl, {
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(res.status).toBe(402);
    expect(calls).toBe(1);
  });

  it("retries past a transient throw + a boot-window 502, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED (TLS not ready)");
      if (calls === 2) return new Response("bad gateway", { status: 502 });
      return new Response("quote", { status: 402 });
    }) as unknown as typeof fetch;

    const res = await waitForUnpaid402("https://echo.example/echo", fetchImpl, {
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(res.status).toBe(402);
    expect(calls).toBe(3);
  });

  it("throws a clear timeout error when 402 never arrives", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    await expect(
      waitForUnpaid402("https://echo.example/echo", fetchImpl, {
        timeoutMs: 5,
        intervalMs: 1,
      }),
    ).rejects.toThrow(/never returned 402/);
  });
});

// ---------------------------------------------------------------------------
// Sidecar topology (wave BC2b): the two-container PAIR. NO docker, NO chain - a
// dockerode/runner stub records build, create, connect, inspect, and remove calls so
// the pure launch wiring (naming, env split, IP-by-inspect, network membership,
// labels, trusted-vs-untrusted spec) is asserted without a live runsc daemon.
// ---------------------------------------------------------------------------

const CLASSIFIER_SCHEMA = JSON.stringify({ openapi: "3.1.0", info: { title: "Echo" } });
const FACILITATOR_TOKEN = "rid.0xabc.deadbeefdeadbeefdeadbeefdeadbeef";

describe("pairNames / sidecarContainerUrl", () => {
  it("derives dns-safe container names that match SERVICE_NAME_PATTERN", () => {
    const { handlerName, sidecarName } = pairNames("echo");
    expect(handlerName).toBe("utter_res_echo-handler");
    expect(sidecarName).toBe("utter_res_echo-gate");
    expect(SERVICE_NAME_PATTERN.test(handlerName)).toBe(true);
    expect(SERVICE_NAME_PATTERN.test(sidecarName)).toBe(true);
  });

  it("points the Traefik target at the SIDECAR (gate), not the handler", () => {
    expect(sidecarContainerUrl("echo")).toBe("http://utter_res_echo-gate:8080");
  });
});

describe("buildHandlerServiceEnv / buildSidecarServiceEnv", () => {
  it("handler env carries NO FACILITATOR_URL and NO token, and passes the untrusted guard", () => {
    const env = buildHandlerServiceEnv({
      resourceId: RESOURCE_ID,
      cap: 10_000n,
      pricing: PRICING,
      maxTimeoutSeconds: 30,
      port: 8080,
    });
    expect(env.FACILITATOR_URL).toBeUndefined();
    expect(env.SIDECAR_FACILITATOR_TOKEN).toBeUndefined();
    expect(env.HANDLER_URL).toBeUndefined();
    expect(env.CLASSIFIER_SCHEMA).toBeUndefined();
    expect(env).toEqual({
      RESOURCE_ID,
      PORT: "8080",
      CAP: "10000",
      MAX_TIMEOUT_SECONDS: "30",
      PRICE_BASE: "5000",
      PRICE_PER_KB: "100",
      PRICE_MAX: "200",
    });
    // The untrusted secret-guarded spec MUST admit the gate-less env unchanged.
    const spec = buildResourceServiceSpec({
      backend: "gvisor",
      image: "utter-resource-echo-handler:latest",
      limits: ECHO_SERVICE.limits,
      network: "proxynet",
      env,
      name: "utter_res_echo-handler",
      port: 8080,
    });
    expect(spec.env).toEqual(env);
  });

  it("sidecar env carries FACILITATOR_URL + HANDLER_URL + token + classifier schema", () => {
    const env = buildSidecarServiceEnv({
      facilitatorUrl: "http://172.20.0.5:8787",
      resourceId: RESOURCE_ID,
      cap: 10_000n,
      pricing: PRICING,
      maxTimeoutSeconds: 30,
      handlerUrl: "http://172.30.0.9:8080",
      facilitatorToken: FACILITATOR_TOKEN,
      classifierSchema: CLASSIFIER_SCHEMA,
      port: 8080,
    });
    expect(env.FACILITATOR_URL).toBe("http://172.20.0.5:8787");
    expect(env.HANDLER_URL).toBe("http://172.30.0.9:8080");
    expect(env.SIDECAR_FACILITATOR_TOKEN).toBe(FACILITATOR_TOKEN);
    expect(env.CLASSIFIER_SCHEMA).toBe(CLASSIFIER_SCHEMA);
  });
});

/**
 * A minimal dockerode + build stub. It satisfies: buildResourceImage's
 * buildImage/modem.followProgress (so build.built === true), GvisorRunner's
 * createContainer/getNetwork().connect/container.start(), launchResourcePair's
 * getContainer(id).inspect() for the handler IP, and getContainer(name).remove()
 * for idempotency. It records every call so the test can assert the launch flow.
 */
function makePairStub(handlerIp: string) {
  const calls = {
    builtTags: [] as string[],
    createOrder: [] as Array<Docker.ContainerCreateOptions>,
    connects: [] as Array<{ network: string; container: string }>,
    inspectedIds: [] as string[],
    removed: [] as string[],
  };
  // Each createContainer mints a distinct id from its name so inspect can key off it.
  let createIdx = 0;

  const docker = {
    // --- build path (buildResourceImage) ---
    async buildImage(_context: unknown, opts: { t: string }) {
      calls.builtTags.push(opts.t);
      return { tag: opts.t } as unknown;
    },
    modem: {
      followProgress(
        _stream: unknown,
        onFinished: (err: Error | null) => void,
        onProgress: (e: { aux?: { ID?: string } }) => void,
      ) {
        onProgress({ aux: { ID: "sha256:stub" } });
        onFinished(null);
      },
    },
    // --- runner path (GvisorRunner.startService) ---
    async createContainer(opts: Docker.ContainerCreateOptions) {
      calls.createOrder.push(opts);
      const id = `cid-${createIdx++}-${opts.name}`;
      return { id, async start() {} } as unknown as Docker.Container;
    },
    getNetwork(network: string) {
      return {
        async connect({ Container }: { Container: string }) {
          calls.connects.push({ network, container: Container });
        },
      };
    },
    getContainer(idOrName: string) {
      return {
        async remove() {
          calls.removed.push(idOrName);
        },
        async inspect() {
          calls.inspectedIds.push(idOrName);
          return {
            NetworkSettings: {
              Networks: {
                proxynet: { IPAddress: handlerIp },
              },
            },
          };
        },
      };
    },
  };

  return { docker: docker as unknown as DockerHandle, calls };
}

describe("launchResourcePair", () => {
  it("builds both images, runs handler then sidecar, and wires HANDLER_URL to the inspected IP", async () => {
    const { docker, calls } = makePairStub("172.30.0.9");

    const result = await launchResourcePair(docker, {
      resourceId: RESOURCE_ID,
      slug: "echo",
      cap: 10_000n,
      pricing: PRICING,
      maxTimeoutSeconds: 30,
      facilitatorUrl: "http://172.20.0.5:8787",
      facilitatorToken: FACILITATOR_TOKEN,
      classifierSchema: CLASSIFIER_SCHEMA,
    });

    // Both images built.
    expect(calls.builtTags).toEqual([
      "utter-resource-echo-handler:latest",
      "utter-resource-echo-gate:latest",
    ]);
    expect(result.handlerImage).toBe("utter-resource-echo-handler:latest");
    expect(result.sidecarImage).toBe("utter-resource-echo-gate:latest");

    // startService called TWICE, handler first then sidecar (create order proves it).
    expect(calls.createOrder.map((c) => c.name)).toEqual([
      "utter_res_echo-handler",
      "utter_res_echo-gate",
    ]);

    const handlerCreate = calls.createOrder[0]!;
    const sidecarCreate = calls.createOrder[1]!;

    // The handler container was inspected for its IP (id of the first created container).
    expect(calls.inspectedIds).toContain("cid-0-utter_res_echo-handler");

    // The handler joins ONLY proxynet; it carries NO facilitator route + NO token.
    expect(handlerCreate.HostConfig!.NetworkMode).toBe("proxynet");
    const handlerEnv = Object.fromEntries(
      (handlerCreate.Env ?? []).map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    expect(handlerEnv.FACILITATOR_URL).toBeUndefined();
    expect(handlerEnv.SIDECAR_FACILITATOR_TOKEN).toBeUndefined();
    expect(handlerEnv.HANDLER_URL).toBeUndefined();

    // The sidecar's primary is ingress; it joins controlplane + proxynet as extras.
    expect(sidecarCreate.HostConfig!.NetworkMode).toBe("ingress");
    const sidecarConnects = calls.connects
      .filter((c) => c.container === "cid-1-utter_res_echo-gate")
      .map((c) => c.network);
    expect(sidecarConnects).toEqual(["controlplane", "proxynet"]);

    // The sidecar holds the facilitator route, the token, the schema, and the
    // HANDLER_URL == the inspected handler IP (the runsc sidecar reaches by IP).
    const sidecarEnv = Object.fromEntries(
      (sidecarCreate.Env ?? []).map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    expect(sidecarEnv.HANDLER_URL).toBe("http://172.30.0.9:8080");
    expect(sidecarEnv.FACILITATOR_URL).toBe("http://172.20.0.5:8787");
    expect(sidecarEnv.SIDECAR_FACILITATOR_TOKEN).toBe(FACILITATOR_TOKEN);
    expect(sidecarEnv.CLASSIFIER_SCHEMA).toBe(CLASSIFIER_SCHEMA);

    // Both containers carry the resourceId + slug + role labels.
    expect(handlerCreate.Labels).toEqual({
      [RESOURCE_ID_LABEL]: RESOURCE_ID,
      [SLUG_LABEL]: "echo",
      [ROLE_LABEL]: "handler",
    });
    expect(sidecarCreate.Labels).toEqual({
      [RESOURCE_ID_LABEL]: RESOURCE_ID,
      [SLUG_LABEL]: "echo",
      [ROLE_LABEL]: "gate",
    });
  });

  it("throws when the handler IP cannot be inspected", async () => {
    const { docker } = makePairStub(""); // empty IP -> unresolved

    await expect(
      launchResourcePair(docker, {
        resourceId: RESOURCE_ID,
        slug: "echo",
        cap: 10_000n,
        pricing: PRICING,
        maxTimeoutSeconds: 30,
        facilitatorUrl: "http://172.20.0.5:8787",
        facilitatorToken: FACILITATOR_TOKEN,
        classifierSchema: CLASSIFIER_SCHEMA,
      }),
    ).rejects.toThrow(/could not resolve the handler's IP/);
  });
});

describe("reapResourcePair", () => {
  it("force-removes every container labeled with the slug + removes the route file", async () => {
    const removed: string[] = [];
    let listedFilter: unknown;
    const docker = {
      async listContainers(opts: { filters: { label: string[] } }) {
        listedFilter = opts.filters.label;
        return [
          { Id: "cid-handler" },
          { Id: "cid-gate" },
        ] as Array<{ Id: string }>;
      },
      getContainer(id: string) {
        return {
          async remove() {
            removed.push(id);
          },
        };
      },
    } as unknown as DockerHandle;

    // reapResourcePair uses the module's default dynamic dir for the route removal
    // (a no-op ENOENT when absent, exercised in the writer/remover suite above); here
    // we assert the container teardown (force-remove EVERY labeled container) + that
    // the list filter targets the slug label.
    await reapResourcePair(docker, "echo");

    expect(removed).toEqual(["cid-handler", "cid-gate"]);
    expect(listedFilter).toEqual([`${SLUG_LABEL}=echo`]);
  });
});
