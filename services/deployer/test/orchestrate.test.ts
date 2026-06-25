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
 * A minimal dockerode + build stub. It satisfies: buildResourceImage's
 * buildImage/modem.followProgress (so build.built === true), GvisorRunner's
 * createContainer/getNetwork().connect/container.start(), launchResourcePair's
 * getContainer(id).inspect() for the handler IP, and getContainer(name).remove()
 * for idempotency. It records every call so the test can assert the launch flow.
 */
function makePairStub(handlerIp: string, opts: { createNetworkThrows409?: boolean } = {}) {
  const calls = {
    builtTags: [] as string[],
    createOrder: [] as Array<Docker.ContainerCreateOptions>,
    connects: [] as Array<{ network: string; container: string }>,
    inspectedIds: [] as string[],
    removed: [] as string[],
    createdNetworks: [] as Array<{ Name: string; Internal?: boolean; Labels?: Record<string, string> }>,
    // A single ordered event log so a test can assert createNetwork precedes the
    // handler container create (the FATAL ordering requirement).
    order: [] as string[],
  };
  // Each createContainer mints a distinct id from its name so inspect can key off it.
  let createIdx = 0;
  // The handler joins its per-slug pairnet now (not proxynet); inspect must report the
  // IP under whatever network the handler was created on. We read the NetworkMode of
  // the FIRST created container so the inspect mirrors the real handler network.
  let handlerNetworkMode = "";

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
      if (opts.createNetworkThrows409) {
        const err = new Error("network with name already exists") as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      calls.createdNetworks.push(spec);
      return { id: `net-${spec.Name}` } as unknown;
    },
    // --- runner path (GvisorRunner.startService) ---
    async createContainer(createOpts: Docker.ContainerCreateOptions) {
      calls.createOrder.push(createOpts);
      calls.order.push(`createContainer:${createOpts.name}`);
      if (createIdx === 0) {
        handlerNetworkMode = (createOpts.HostConfig?.NetworkMode as string) ?? "";
      }
      const id = `cid-${createIdx++}-${createOpts.name}`;
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
                // Report the handler IP under the network it was actually created on
                // (the per-slug pairnet by default), so the IP read keys off it.
                [handlerNetworkMode || "proxynet"]: { IPAddress: handlerIp },
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

    // The per-slug pairnet was created with Internal:true + the GC label, and BEFORE
    // the handler container (the FATAL ordering requirement: the pairnet is the
    // handler's create-time NetworkMode, so it must exist first).
    const pairnet = pairnetName("echo");
    expect(pairnet).toBe("utter_pairnet_echo");
    const createdPairnet = calls.createdNetworks.find((n) => n.Name === pairnet);
    expect(createdPairnet).toBeDefined();
    expect(createdPairnet!.Internal).toBe(true);
    expect(createdPairnet!.Labels?.[PAIRNET_KIND_LABEL]).toBe(PAIRNET_KIND);
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

  it("succeeds idempotently when the pairnet already exists (createNetwork 409)", async () => {
    const { docker, calls } = makePairStub("172.30.0.9", { createNetworkThrows409: true });

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

    // The 409 was swallowed (treated as success) and the pair still launched on the
    // (pre-existing) pairnet: both containers were created.
    expect(calls.order).toContain(`createNetwork:${pairnetName("echo")}`);
    expect(calls.createOrder.map((c) => c.name)).toEqual([
      "utter_res_echo-handler",
      "utter_res_echo-gate",
    ]);
    expect(result.handlerImage).toBe("utter-resource-echo-handler:latest");
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
 * A docker stub modelling a tiny NETWORK registry + a per-slug CONTAINER list, so the
 * pairnet teardown lifecycle (remove-on-last, not-while-sibling, orphan GC, idempotent
 * 404) can be asserted autonomously. `networks` is keyed by name; each entry tracks its
 * attached container count + a labels map. `containersBySlug` is the listContainers
 * result the reaper reads back. Records every remove for assertions.
 */
function makeLifecycleStub(init: {
  networks?: Record<string, { attached: number; labels?: Record<string, string>; id?: string }>;
  containersBySlug?: Record<string, Array<{ Id: string }>>;
}) {
  const networks: Record<string, { attached: number; labels?: Record<string, string>; id: string }> = {};
  for (const [name, n] of Object.entries(init.networks ?? {})) {
    networks[name] = { attached: n.attached, labels: n.labels, id: n.id ?? `net-${name}` };
  }
  const containersBySlug = init.containersBySlug ?? {};
  const calls = {
    removedContainers: [] as string[],
    removedNetworks: [] as string[],
    inspectedNetworks: [] as string[],
  };

  // Resolve a network entry by name OR by id (listNetworks hands back ids).
  function findNet(idOrName: string) {
    if (networks[idOrName]) return { name: idOrName, entry: networks[idOrName] };
    for (const [name, entry] of Object.entries(networks)) {
      if (entry.id === idOrName) return { name, entry };
    }
    return undefined;
  }

  const docker = {
    async listContainers(opts: { filters: { label: string[] } }) {
      // The only label filter the reaper uses is `${SLUG_LABEL}=<slug>`.
      const label = opts.filters.label[0] ?? "";
      const slug = label.startsWith(`${SLUG_LABEL}=`) ? label.slice(`${SLUG_LABEL}=`.length) : "";
      return (containersBySlug[slug] ?? []) as Array<{ Id: string }>;
    },
    async listNetworks(opts: { filters: { label: string[] } }) {
      const want = opts.filters.label[0] ?? "";
      return Object.entries(networks)
        .filter(([, e]) => {
          const kind = e.labels?.[PAIRNET_KIND_LABEL];
          return want === `${PAIRNET_KIND_LABEL}=${kind}`;
        })
        .map(([, e]) => ({ Id: e.id }));
    },
    getContainer(id: string) {
      return {
        async remove() {
          calls.removedContainers.push(id);
        },
      };
    },
    getNetwork(idOrName: string) {
      return {
        async inspect() {
          calls.inspectedNetworks.push(idOrName);
          const found = findNet(idOrName);
          if (!found) {
            const err = new Error("network not found") as Error & { statusCode?: number };
            err.statusCode = 404;
            throw err;
          }
          const containers: Record<string, unknown> = {};
          for (let i = 0; i < found.entry.attached; i += 1) containers[`c${i}`] = {};
          return { Containers: containers };
        },
        async remove() {
          const found = findNet(idOrName);
          if (!found) {
            const err = new Error("network not found") as Error & { statusCode?: number };
            err.statusCode = 404;
            throw err;
          }
          calls.removedNetworks.push(found.name);
          delete networks[found.name];
        },
      };
    },
  } as unknown as DockerHandle;

  return { docker, calls, networks };
}

describe("reapResourcePair", () => {
  it("force-removes every container labeled with the slug + the route + the pairnet", async () => {
    const pairnet = pairnetName("echo");
    const { docker, calls } = makeLifecycleStub({
      // After the containers are reaped the pairnet is endpoint-less (attached 0).
      networks: { [pairnet]: { attached: 0, labels: { [PAIRNET_KIND_LABEL]: PAIRNET_KIND } } },
      containersBySlug: { echo: [{ Id: "cid-handler" }, { Id: "cid-gate" }] },
    });

    // reapResourcePair uses the module's default dynamic dir for the route removal
    // (a no-op ENOENT when absent); here we assert the container teardown (force-remove
    // EVERY labeled container) + that the per-resource pairnet is removed after them.
    await reapResourcePair(docker, "echo");

    expect(calls.removedContainers).toEqual(["cid-handler", "cid-gate"]);
    expect(calls.removedNetworks).toEqual([pairnet]);
  });
});

describe("reapResourceContainer - pairnet teardown (the reconcile seam, the FATAL fix)", () => {
  function actual(id: string, slug: string): ActualContainer {
    return { id, resourceId: RESOURCE_ID, running: true, slug };
  }

  it("does NOT remove the pairnet while a sibling slug-container remains", async () => {
    const pairnet = pairnetName("echo");
    const { docker, calls } = makeLifecycleStub({
      networks: { [pairnet]: { attached: 1, labels: { [PAIRNET_KIND_LABEL]: PAIRNET_KIND } } },
      // After removing the handler, the gate is STILL present (sibling remains).
      containersBySlug: { echo: [{ Id: "cid-0-utter_res_echo-handler" }, { Id: "cid-1-utter_res_echo-gate" }] },
    });

    await reapResourceContainer(docker, actual("cid-0-utter_res_echo-handler", "echo"));

    // The handler container was force-removed, but the pairnet was NOT touched (the
    // gate sibling still holds it).
    expect(calls.removedContainers).toContain("cid-0-utter_res_echo-handler");
    expect(calls.removedNetworks).toEqual([]);
  });

  it("removes the pairnet exactly once when the LAST slug-container is reaped", async () => {
    const pairnet = pairnetName("echo");
    const { docker, calls } = makeLifecycleStub({
      // The pairnet has no endpoints left once the last container is gone.
      networks: { [pairnet]: { attached: 0, labels: { [PAIRNET_KIND_LABEL]: PAIRNET_KIND } } },
      // The list (after this container is removed) reports ONLY this id, so excluding it
      // leaves zero -> this is the last container.
      containersBySlug: { echo: [{ Id: "cid-1-utter_res_echo-gate" }] },
    });

    await reapResourceContainer(docker, actual("cid-1-utter_res_echo-gate", "echo"));

    expect(calls.removedContainers).toContain("cid-1-utter_res_echo-gate");
    expect(calls.removedNetworks).toEqual([pairnet]);
  });

  it("swallows a 404 when the pairnet is already gone (idempotent)", async () => {
    // No network in the registry: inspect/remove both 404. The reap must not throw.
    const { docker, calls } = makeLifecycleStub({
      networks: {},
      containersBySlug: { echo: [{ Id: "cid-1-utter_res_echo-gate" }] },
    });

    await expect(
      reapResourceContainer(docker, actual("cid-1-utter_res_echo-gate", "echo")),
    ).resolves.toBeUndefined();
    expect(calls.removedNetworks).toEqual([]);
  });
});

describe("reapOrphanPairNetworks - the orphan-network GC sweep", () => {
  it("removes a labeled endpoint-less pairnet and SKIPS one with an attached container", async () => {
    const orphan = pairnetName("orphan");
    const live = pairnetName("live");
    const { docker, calls } = makeLifecycleStub({
      networks: {
        [orphan]: { attached: 0, labels: { [PAIRNET_KIND_LABEL]: PAIRNET_KIND } },
        [live]: { attached: 2, labels: { [PAIRNET_KIND_LABEL]: PAIRNET_KIND } },
      },
    });

    await reapOrphanPairNetworks(docker);

    // The endpoint-less orphan is swept; the in-use one is left alone.
    expect(calls.removedNetworks).toEqual([orphan]);
  });

  it("is a no-op when there are no labeled pairnets", async () => {
    const { docker, calls } = makeLifecycleStub({ networks: {} });
    await expect(reapOrphanPairNetworks(docker)).resolves.toBeUndefined();
    expect(calls.removedNetworks).toEqual([]);
  });
});
