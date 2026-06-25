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
  pairnetName,
  sidecarContainerUrl,
  launchResourcePair,
  reapResourcePair,
  reapResourceContainer,
  reapOrphanPairNetworks,
  writeTraefikDynamicFile,
  removeTraefikDynamicFile,
  resolveDockerHandle,
  resolveFacilitatorUrl,
  waitForUnpaid402,
  ECHO_SERVICE,
  RESOURCE_ID_LABEL,
  SLUG_LABEL,
  ROLE_LABEL,
  PAIRNET_KIND_LABEL,
  PAIRNET_KIND,
  type DockerHandle,
} from "../src/orchestrate";
import type { ActualContainer } from "../src/reconcile";
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

  it("inspects the network passed in opts.network (locks the live-deploy six-net contract)", async () => {
    let inspected: string | undefined;
    const docker = stubDocker(
      {
        c1: { Name: "utter_facilitator_1", IPv4Address: "172.30.0.7/16" },
      },
      (n) => {
        inspected = n;
      },
    );

    const url = await resolveFacilitatorUrl(docker, { network: "controlplane" });
    expect(url).toBe("http://172.30.0.7:8787");
    expect(inspected).toBe("controlplane");
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

  it("sidecar env emits MAX_RESPONSE_BYTES (fix F2) when pricing carries a positive cap", () => {
    const env = buildSidecarServiceEnv({
      facilitatorUrl: "http://172.20.0.5:8787",
      resourceId: RESOURCE_ID,
      cap: 10_000n,
      pricing: PRICING, // PRICING.maxResponseBytes === 1_048_576
      maxTimeoutSeconds: 30,
      handlerUrl: "http://172.30.0.9:8080",
      facilitatorToken: FACILITATOR_TOKEN,
      classifierSchema: CLASSIFIER_SCHEMA,
      port: 8080,
    });
    // The configured size cap reaches the sidecar gate as a public integer string, so
    // F1's MAX_RESPONSE_BYTES parsing (metering size term + bounded proxy read) applies.
    expect(env.MAX_RESPONSE_BYTES).toBe("1048576");
  });

  it("sidecar env OMITS MAX_RESPONSE_BYTES when the cap is unset, zero, or negative", () => {
    for (const maxResponseBytes of [undefined, 0, -1] as Array<number | undefined>) {
      const env = buildSidecarServiceEnv({
        facilitatorUrl: "http://172.20.0.5:8787",
        resourceId: RESOURCE_ID,
        cap: 10_000n,
        pricing: { model: "metered", base: "5000", perKB: "100", computeMultiplier: "200", maxResponseBytes },
        maxTimeoutSeconds: 30,
        handlerUrl: "http://172.30.0.9:8080",
        facilitatorToken: FACILITATOR_TOKEN,
        classifierSchema: CLASSIFIER_SCHEMA,
        port: 8080,
      });
      // Omitted (not "0") so loadSidecarConfig keeps its hard DEFAULT_MAX_RESPONSE_BYTES.
      expect(env.MAX_RESPONSE_BYTES).toBeUndefined();
    }
  });

  it("sidecar env emits FREE_PATHS defaulting to the single agent-card route", () => {
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
    // The echo's ONLY free route: an EXACT CSV, not the wider in-sidecar default trio.
    expect(env.FREE_PATHS).toBe("/.well-known/agent-card.json");
  });

  it("sidecar env honors an explicit freePaths list (comma-joined, exact)", () => {
    const env = buildSidecarServiceEnv({
      facilitatorUrl: "http://172.20.0.5:8787",
      resourceId: RESOURCE_ID,
      cap: 10_000n,
      pricing: PRICING,
      maxTimeoutSeconds: 30,
      handlerUrl: "http://172.30.0.9:8080",
      facilitatorToken: FACILITATOR_TOKEN,
      classifierSchema: CLASSIFIER_SCHEMA,
      freePaths: ["/.well-known/agent-card.json", "/healthz"],
      port: 8080,
    });
    expect(env.FREE_PATHS).toBe("/.well-known/agent-card.json,/healthz");
  });

  it("handler env carries NEITHER MAX_RESPONSE_BYTES NOR FREE_PATHS (only the sidecar gates)", () => {
    const env = buildHandlerServiceEnv({
      resourceId: RESOURCE_ID,
      cap: 10_000n,
      pricing: PRICING, // even with a positive maxResponseBytes, the handler gets neither
      maxTimeoutSeconds: 30,
      port: 8080,
    });
    expect(env.MAX_RESPONSE_BYTES).toBeUndefined();
    expect(env.FREE_PATHS).toBeUndefined();
  });
});

/**
 * A STATEFUL dockerode + build stub (quick 260625-mwb FIX B). Unlike a static snapshot,
 * this models a real network registry + container registry that MUTATE as launch/reap
 * run, so the lifecycle tests assert genuine post-state instead of a pre-configured
 * final state. It satisfies the full launch + reap surface:
 *
 *   - buildImage/modem.followProgress (so buildResourceImage.built === true).
 *   - createNetwork: registers a network; throws a 409-shaped error if it already
 *     exists (exercising ensurePairNetwork's idempotency + collision guard).
 *   - createContainer: registers a container AND attaches it as an endpoint on its
 *     primary network (HostConfig.NetworkMode); returns { id, start() }.
 *   - getNetwork(name|id).connect: attaches the container as an endpoint on that extra
 *     network (the post-create connect GvisorRunner does for each extra net).
 *   - getNetwork(name|id).inspect: returns the LIVE Containers map + Labels.
 *   - getNetwork(name|id).remove: throws a 403/in-use-shaped error if the Containers
 *     map is non-empty, else deletes the network from the registry.
 *   - getContainer(id|name).inspect: returns the container's per-network IP for the
 *     handler-IP read (and a benign NetworkSettings for a name miss).
 *   - getContainer(id|name).remove: removes the container AND detaches it from EVERY
 *     network's Containers map (so the network endpoint count drops, exactly as Docker
 *     does on a force-remove).
 *   - listNetworks / listContainers: reflect the live registry with label filtering.
 *
 * Records every call so the existing launch-flow assertions keep working, and exposes
 * the live `networks` / `containers` registries so lifecycle tests can assert post-state.
 *
 * @param handlerIp the IP the handler reports on its primary network (empty -> unresolved).
 * @param opts.seedNetworks pre-existing networks (name -> labels) to model a redeploy or
 *        a slug-collision (a pairnet already owned by another resource).
 */
function makePairStub(
  handlerIp: string,
  opts: { seedNetworks?: Record<string, Record<string, string>> } = {},
) {
  interface NetEntry {
    id: string;
    Labels: Record<string, string>;
    Containers: Record<string, unknown>; // endpoint id -> {} (the live attachment set)
  }
  interface ContainerEntry {
    id: string;
    name: string;
    primaryNetwork: string;
    Labels: Record<string, string>;
    networks: Set<string>; // every network name this container is attached to
  }

  const networks: Record<string, NetEntry> = {};
  for (const [name, labels] of Object.entries(opts.seedNetworks ?? {})) {
    networks[name] = { id: `net-${name}`, Labels: { ...labels }, Containers: {} };
  }
  const containers: Record<string, ContainerEntry> = {};

  const calls = {
    builtTags: [] as string[],
    createOrder: [] as Array<Docker.ContainerCreateOptions>,
    connects: [] as Array<{ network: string; container: string }>,
    inspectedIds: [] as string[],
    removed: [] as string[],
    createdNetworks: [] as Array<{ Name: string; Internal?: boolean; Labels?: Record<string, string> }>,
    removedNetworks: [] as string[],
    // Every getNetwork().remove() ATTEMPT (recorded BEFORE the in-use 403 check), so a
    // test can prove the reap never even tried to remove a pairnet that still had an
    // endpoint (catches a reverted FIX A / a premature remove that the daemon's 403
    // would otherwise silently absorb).
    attemptedNetworkRemoves: [] as string[],
    inspectedNetworks: [] as string[],
    // A single ordered event log so a test can assert createNetwork precedes the
    // handler container create (the FATAL ordering requirement).
    order: [] as string[],
  };
  let createIdx = 0;

  // Resolve a network entry by name OR by id (listNetworks hands back ids).
  function findNet(idOrName: string): { name: string; entry: NetEntry } | undefined {
    if (networks[idOrName]) return { name: idOrName, entry: networks[idOrName]! };
    for (const [name, entry] of Object.entries(networks)) {
      if (entry.id === idOrName) return { name, entry };
    }
    return undefined;
  }

  // Attach a container endpoint to a network's live Containers map (createContainer +
  // connect both route here so the endpoint count is always the source of truth).
  function attach(netName: string, containerId: string) {
    const entry = networks[netName];
    if (!entry) return; // attaching to an unknown/dev-override net: ignored in the model.
    entry.Containers[containerId] = {};
    containers[containerId]?.networks.add(netName);
  }

  const docker = {
    // --- build path (buildResourceImage) ---
    async buildImage(_context: unknown, opts2: { t: string }) {
      calls.builtTags.push(opts2.t);
      return { tag: opts2.t } as unknown;
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
    // --- network path (ensurePairNetwork) ---
    async createNetwork(spec: { Name: string; Internal?: boolean; Labels?: Record<string, string> }) {
      calls.order.push(`createNetwork:${spec.Name}`);
      if (networks[spec.Name]) {
        // Already exists: 409, exactly as the daemon does (drives the idempotency +
        // collision guard, which then inspect()s the existing net's Labels).
        const err = new Error("network with name already exists") as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      calls.createdNetworks.push(spec);
      networks[spec.Name] = {
        id: `net-${spec.Name}`,
        Labels: { ...(spec.Labels ?? {}) },
        Containers: {},
      };
      return { id: networks[spec.Name]!.id } as unknown;
    },
    async listNetworks(listOpts: { filters: { label: string[] } }) {
      const want = listOpts.filters.label[0] ?? "";
      return Object.values(networks)
        .filter((e) => {
          const kind = e.Labels[PAIRNET_KIND_LABEL];
          return want === `${PAIRNET_KIND_LABEL}=${kind}`;
        })
        .map((e) => ({ Id: e.id }));
    },
    async listContainers(listOpts: { filters: { label: string[] } }) {
      const label = listOpts.filters.label[0] ?? "";
      const eq = label.indexOf("=");
      const key = eq >= 0 ? label.slice(0, eq) : label;
      const val = eq >= 0 ? label.slice(eq + 1) : undefined;
      return Object.values(containers)
        .filter((c) => (val === undefined ? c.Labels[key] !== undefined : c.Labels[key] === val))
        .map((c) => ({ Id: c.id, Labels: c.Labels, State: "running" }));
    },
    // --- runner path (GvisorRunner.startService) ---
    async createContainer(createOpts: Docker.ContainerCreateOptions) {
      calls.createOrder.push(createOpts);
      calls.order.push(`createContainer:${createOpts.name}`);
      const id = `cid-${createIdx++}-${createOpts.name}`;
      const primaryNetwork = (createOpts.HostConfig?.NetworkMode as string) ?? "";
      containers[id] = {
        id,
        name: createOpts.name ?? id,
        primaryNetwork,
        Labels: { ...((createOpts.Labels as Record<string, string>) ?? {}) },
        networks: new Set<string>(),
      };
      // Attach as an endpoint on the primary network (mirrors a Docker create with a
      // NetworkMode: the container boots already attached there).
      attach(primaryNetwork, id);
      return { id, async start() {} } as unknown as Docker.Container;
    },
    getNetwork(idOrName: string) {
      return {
        async connect({ Container }: { Container: string }) {
          calls.connects.push({ network: idOrName, container: Container });
          const found = findNet(idOrName);
          if (found) attach(found.name, Container);
        },
        async inspect() {
          calls.inspectedNetworks.push(idOrName);
          const found = findNet(idOrName);
          if (!found) {
            const err = new Error("network not found") as Error & { statusCode?: number };
            err.statusCode = 404;
            throw err;
          }
          return { Labels: found.entry.Labels, Containers: { ...found.entry.Containers } };
        },
        async remove() {
          const found = findNet(idOrName);
          if (!found) {
            const err = new Error("network not found") as Error & { statusCode?: number };
            err.statusCode = 404;
            throw err;
          }
          calls.attemptedNetworkRemoves.push(found.name);
          if (Object.keys(found.entry.Containers).length > 0) {
            // In-use: the daemon refuses with a 403 (this is the leak-guard the reap
            // paths MUST respect - they inspect first and never force this).
            const err = new Error(
              `network ${found.name} has active endpoints`,
            ) as Error & { statusCode?: number };
            err.statusCode = 403;
            throw err;
          }
          calls.removedNetworks.push(found.name);
          delete networks[found.name];
        },
      };
    },
    getContainer(idOrName: string) {
      return {
        async remove() {
          calls.removed.push(idOrName);
          const entry = containers[idOrName];
          if (!entry) return; // name-keyed idempotency remove for a non-existent container.
          // Detach from EVERY network's live Containers map (a force-remove drops every
          // endpoint), then delete the container.
          for (const netName of entry.networks) {
            const n = networks[netName];
            if (n) delete n.Containers[entry.id];
          }
          delete containers[idOrName];
        },
        async inspect() {
          calls.inspectedIds.push(idOrName);
          const entry = containers[idOrName];
          const net = entry?.primaryNetwork || "proxynet";
          return {
            NetworkSettings: {
              Networks: {
                [net]: { IPAddress: handlerIp },
              },
            },
          };
        },
      };
    },
  };

  return { docker: docker as unknown as DockerHandle, calls, networks, containers };
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

    // The per-slug pairnet was created with Internal:true + the GC label, and BEFORE
    // the handler container (the FATAL ordering requirement: the pairnet is the
    // handler's create-time NetworkMode, so it must exist first).
    const pairnet = pairnetName("echo");
    expect(pairnet).toBe("utter_pairnet_echo");
    const createdPairnet = calls.createdNetworks.find((n) => n.Name === pairnet);
    expect(createdPairnet).toBeDefined();
    expect(createdPairnet!.Internal).toBe(true);
    expect(createdPairnet!.Labels?.[PAIRNET_KIND_LABEL]).toBe(PAIRNET_KIND);
    // FIX C: the pairnet is stamped with its owning resourceId so a slug-collision
    // (a different resource reusing this slug) can be caught and refused.
    expect(createdPairnet!.Labels?.[RESOURCE_ID_LABEL]).toBe(RESOURCE_ID);
    expect(createdPairnet!.Labels?.[SLUG_LABEL]).toBe("echo");
    const netIdx = calls.order.indexOf(`createNetwork:${pairnet}`);
    const handlerIdx = calls.order.indexOf("createContainer:utter_res_echo-handler");
    expect(netIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThan(netIdx);

    // The handler joins ONLY its per-slug pairnet (NOT the shared proxynet); it carries
    // NO facilitator route + NO token.
    expect(handlerCreate.HostConfig!.NetworkMode).toBe(pairnet);
    const handlerEnv = Object.fromEntries(
      (handlerCreate.Env ?? []).map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    expect(handlerEnv.FACILITATOR_URL).toBeUndefined();
    expect(handlerEnv.SIDECAR_FACILITATOR_TOKEN).toBeUndefined();
    expect(handlerEnv.HANDLER_URL).toBeUndefined();

    // The sidecar's primary is ingress; it joins controlplane + the per-slug pairnet as
    // extras and does NOT join the shared proxynet (the cross-tenant fix).
    expect(sidecarCreate.HostConfig!.NetworkMode).toBe("ingress");
    const sidecarConnects = calls.connects
      .filter((c) => c.container === "cid-1-utter_res_echo-gate")
      .map((c) => c.network);
    expect(sidecarConnects).toEqual(["controlplane", pairnet]);
    expect(sidecarConnects).not.toContain("proxynet");

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

  it("succeeds idempotently when the SAME-owner pairnet already exists (createNetwork 409)", async () => {
    // A prior deploy of THIS resource already minted the pairnet (same resourceId owner).
    const { docker, calls } = makePairStub("172.30.0.9", {
      seedNetworks: {
        [pairnetName("echo")]: {
          [PAIRNET_KIND_LABEL]: PAIRNET_KIND,
          [SLUG_LABEL]: "echo",
          [RESOURCE_ID_LABEL]: RESOURCE_ID,
        },
      },
    });

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

    // The 409 was swallowed (same owner -> idempotent redeploy) and the pair still
    // launched on the pre-existing pairnet: both containers were created.
    expect(calls.order).toContain(`createNetwork:${pairnetName("echo")}`);
    expect(calls.createOrder.map((c) => c.name)).toEqual([
      "utter_res_echo-handler",
      "utter_res_echo-gate",
    ]);
    expect(result.handlerImage).toBe("utter-resource-echo-handler:latest");
  });

  it("THROWS on a slug-collision: an existing pairnet owned by a DIFFERENT resource (FIX C)", async () => {
    // The pairnet for this slug already exists but is owned by ANOTHER resourceId. Co-
    // tenanting would share the internal pairnet across two resources -> the cross-tenant
    // free-compute HIGH. ensurePairNetwork must FAIL LOUD rather than adopt it.
    const otherResource =
      "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
    const { docker, calls } = makePairStub("172.30.0.9", {
      seedNetworks: {
        [pairnetName("echo")]: {
          [PAIRNET_KIND_LABEL]: PAIRNET_KIND,
          [SLUG_LABEL]: "echo",
          [RESOURCE_ID_LABEL]: otherResource,
        },
      },
    });

    await expect(
      launchResourcePair(docker, {
        resourceId: RESOURCE_ID, // different from the existing owner
        slug: "echo",
        cap: 10_000n,
        pricing: PRICING,
        maxTimeoutSeconds: 30,
        facilitatorUrl: "http://172.20.0.5:8787",
        facilitatorToken: FACILITATOR_TOKEN,
        classifierSchema: CLASSIFIER_SCHEMA,
      }),
    ).rejects.toThrow(/already owned by a different resource/);

    // It refused BEFORE creating any pair container (fail loud, no co-tenant launch).
    expect(calls.createOrder).toEqual([]);
  });

  it("adopts an UNLABELED legacy pairnet (no resource-id label) without throwing", async () => {
    // A pairnet created before the FIX C ownership label exists: ensurePairNetwork must
    // adopt it (proceed), not throw, so an in-place upgrade does not break a redeploy.
    const { docker, calls } = makePairStub("172.30.0.9", {
      seedNetworks: {
        [pairnetName("echo")]: {
          [PAIRNET_KIND_LABEL]: PAIRNET_KIND,
          [SLUG_LABEL]: "echo",
          // no RESOURCE_ID_LABEL
        },
      },
    });

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

    expect(result.handlerImage).toBe("utter-resource-echo-handler:latest");
    expect(calls.createOrder.map((c) => c.name)).toEqual([
      "utter_res_echo-handler",
      "utter_res_echo-gate",
    ]);
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

/**
 * Drive a real pair launch through the STATEFUL stub for a slug, returning the launch
 * result. After this resolves the stub's `networks`/`containers` registries hold the
 * live pairnet (with both endpoints attached) and both containers, so the lifecycle
 * tests below assert genuine post-state (not a pre-configured snapshot).
 */
async function launchInto(
  stub: ReturnType<typeof makePairStub>,
  slug: string,
  resourceId: Hex = RESOURCE_ID,
) {
  return launchResourcePair(stub.docker, {
    resourceId,
    slug,
    cap: 10_000n,
    pricing: PRICING,
    maxTimeoutSeconds: 30,
    facilitatorUrl: "http://172.20.0.5:8787",
    facilitatorToken: FACILITATOR_TOKEN,
    classifierSchema: CLASSIFIER_SCHEMA,
  });
}

describe("pairnet lifecycle - STATEFUL stub (FIX B: post-state, not snapshots)", () => {
  function actual(stub: ReturnType<typeof makePairStub>, name: string, slug: string): ActualContainer {
    // Resolve the live container id by its name so reapResourceContainer removes the
    // actual endpoint (the stateful stub keys containers by minted id, named by suffix).
    const entry = Object.values(stub.containers).find((c) => c.name === name);
    if (!entry) throw new Error(`launch produced no container named ${name}`);
    return { id: entry.id, resourceId: RESOURCE_ID, running: true, slug };
  }

  it("creates the internal pairnet BEFORE the handler container (ordering)", async () => {
    const stub = makePairStub("172.30.0.9");
    await launchInto(stub, "echo");

    const pairnet = pairnetName("echo");
    const netIdx = stub.calls.order.indexOf(`createNetwork:${pairnet}`);
    const handlerIdx = stub.calls.order.indexOf("createContainer:utter_res_echo-handler");
    expect(netIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThan(netIdx);
    // Post-state: the pairnet exists with BOTH endpoints (handler primary + sidecar extra).
    expect(Object.keys(stub.networks[pairnet]!.Containers)).toHaveLength(2);
  });

  it("reapResourcePair force-removes both containers + the route + the now-empty pairnet", async () => {
    const stub = makePairStub("172.30.0.9");
    await launchInto(stub, "echo");
    const pairnet = pairnetName("echo");

    await reapResourcePair(stub.docker, "echo");

    // Post-state: both containers gone, the pairnet removed exactly once (it was empty
    // after both endpoints detached).
    expect(Object.keys(stub.containers)).toHaveLength(0);
    expect(stub.networks[pairnet]).toBeUndefined();
    expect(stub.calls.removedNetworks).toEqual([pairnet]);
  });

  it("reap ONE of two: the pairnet STILL EXISTS (the sidecar endpoint remains)", async () => {
    const stub = makePairStub("172.30.0.9");
    await launchInto(stub, "echo");
    const pairnet = pairnetName("echo");

    // Reap the HANDLER only. removePairNetwork must decline (the gate endpoint remains).
    await reapResourceContainer(stub.docker, actual(stub, "utter_res_echo-handler", "echo"));

    expect(stub.networks[pairnet]).toBeDefined();
    // One endpoint (the sidecar) is still attached -> not removed.
    expect(Object.keys(stub.networks[pairnet]!.Containers)).toHaveLength(1);
    expect(stub.calls.removedNetworks).toEqual([]);
    // CRITICAL (catches a reverted FIX A / a premature removal): removePairNetwork must
    // gate off the network's OWN endpoint list and NOT EVEN ATTEMPT net.remove() while
    // the sidecar endpoint is attached. If FIX A is reverted (or the in-use guard in
    // removePairNetwork is dropped) this attempt fires and the assertion fails - the
    // daemon's 403 would otherwise silently absorb a premature remove.
    expect(stub.calls.attemptedNetworkRemoves).toEqual([]);
  });

  it("reap LAST: the pairnet is GONE after the sidecar is reaped (removed exactly once)", async () => {
    const stub = makePairStub("172.30.0.9");
    await launchInto(stub, "echo");
    const pairnet = pairnetName("echo");

    await reapResourceContainer(stub.docker, actual(stub, "utter_res_echo-handler", "echo"));
    expect(stub.networks[pairnet]).toBeDefined(); // still up after the first reap.

    await reapResourceContainer(stub.docker, actual(stub, "utter_res_echo-gate", "echo"));

    // The last endpoint detached -> the pairnet is removed exactly once. The remove was
    // attempted exactly once (on the LAST reap), never on the first.
    expect(stub.networks[pairnet]).toBeUndefined();
    expect(stub.calls.removedNetworks).toEqual([pairnet]);
    expect(stub.calls.attemptedNetworkRemoves).toEqual([pairnet]);
  });

  it("redeploy E2E: launch -> reap both -> launch again same slug -> clean pairnet + success", async () => {
    const stub = makePairStub("172.30.0.9");
    const pairnet = pairnetName("echo");

    // First deploy.
    await launchInto(stub, "echo");
    // Tear the WHOLE pair down (both containers + pairnet).
    await reapResourceContainer(stub.docker, actual(stub, "utter_res_echo-handler", "echo"));
    await reapResourceContainer(stub.docker, actual(stub, "utter_res_echo-gate", "echo"));
    expect(stub.networks[pairnet]).toBeUndefined();
    expect(Object.keys(stub.containers)).toHaveLength(0);

    // Redeploy the SAME slug + resource: ensurePairNetwork recreates the pairnet cleanly
    // (no stale-net 409 to swallow because teardown removed it), and the launch succeeds.
    const result = await launchInto(stub, "echo");
    expect(result.handlerImage).toBe("utter-resource-echo-handler:latest");
    expect(stub.networks[pairnet]).toBeDefined();
    expect(Object.keys(stub.networks[pairnet]!.Containers)).toHaveLength(2);
  });

  it("redeploy over a STALE same-owner pairnet: 409 path is idempotent (FIX C)", async () => {
    // A previous deploy left the pairnet behind (crash before teardown). The pairnet is
    // owned by THIS resource, so ensurePairNetwork's 409 path adopts it (idempotent) and
    // the redeploy succeeds rather than throwing.
    const pairnet = pairnetName("echo");
    const stub = makePairStub("172.30.0.9", {
      seedNetworks: {
        [pairnet]: {
          [PAIRNET_KIND_LABEL]: PAIRNET_KIND,
          [SLUG_LABEL]: "echo",
          [RESOURCE_ID_LABEL]: RESOURCE_ID,
        },
      },
    });

    const result = await launchInto(stub, "echo");
    expect(result.handlerImage).toBe("utter-resource-echo-handler:latest");
    // Both endpoints attached to the adopted pairnet.
    expect(Object.keys(stub.networks[pairnet]!.Containers)).toHaveLength(2);
  });

  it("orphan GC: removes a labeled endpoint-less pairnet, SKIPS one with an attached container", async () => {
    // Launch one pair (live, two endpoints), then create a second pairnet and orphan it
    // by reaping ITS containers' endpoints so it is empty. The GC must sweep ONLY the
    // empty one.
    const stub = makePairStub("172.30.0.9");
    await launchInto(stub, "live");

    // Hand-mint an endpoint-less orphan pairnet directly in the registry (a crash left a
    // labeled pairnet with no containers).
    const orphan = pairnetName("orphan");
    stub.networks[orphan] = {
      id: `net-${orphan}`,
      Labels: { [PAIRNET_KIND_LABEL]: PAIRNET_KIND, [SLUG_LABEL]: "orphan" },
      Containers: {},
    };

    await reapOrphanPairNetworks(stub.docker);

    // The endpoint-less orphan is swept; the live pairnet (2 endpoints) is left alone.
    expect(stub.networks[orphan]).toBeUndefined();
    expect(stub.networks[pairnetName("live")]).toBeDefined();
    expect(stub.calls.removedNetworks).toEqual([orphan]);
  });

  it("orphan GC is a no-op when there are no labeled pairnets", async () => {
    const stub = makePairStub("172.30.0.9");
    await expect(reapOrphanPairNetworks(stub.docker)).resolves.toBeUndefined();
    expect(stub.calls.removedNetworks).toEqual([]);
  });

  it("reapResourceContainer swallows a 404 when the pairnet is already gone (idempotent)", async () => {
    // A container with a slug whose pairnet never existed: inspect/remove both 404 inside
    // removePairNetwork. The reap must not throw.
    const stub = makePairStub("172.30.0.9");
    await expect(
      reapResourceContainer(stub.docker, {
        id: "ghost",
        resourceId: RESOURCE_ID,
        running: true,
        slug: "echo",
      }),
    ).resolves.toBeUndefined();
    expect(stub.calls.removedNetworks).toEqual([]);
  });
});
