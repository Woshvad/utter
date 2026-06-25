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
import type { Hex } from "viem";
import type { Pricing } from "@utter/x402-arc";
import { buildResourceServiceSpec } from "@utter/sandbox";
import {
  buildEchoServiceEnv,
  writeTraefikDynamicFile,
  removeTraefikDynamicFile,
  resolveDockerHandle,
  waitForUnpaid402,
  ECHO_SERVICE,
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
