// capacity.test.ts - the public-hardening PART D proofs (NO docker, NO chain, NO
// host): the POST /deploy capacity admission (UNIT IS CONTAINERS, 2 per resource),
// the fail-closed census (throw AND timeout), the in-flight reservation lifecycle
// (released exactly once on success, error, deadline expiry, and the
// SlugConflictError early return), the capacity-gated hard deploy deadline, the
// positive-int env parse guard, and the Bearer-gated GET /deployments matrix.
// Everything drives createDeployerApp with an injected fake deploy + fake
// listRunning, in the same style as server.test.ts.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { createDeployerApp, parsePositiveInt, type DeployRequest } from "../src/server";
import { createInMemoryStores } from "../src/stores/memory";
import { resourceIdForLabel } from "@utter/x402-arc";
import type { DeployProgressEvent, LiveDeployResult } from "../src/live-deploy";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A >=32-char shared secret (the routes require a non-blank DEPLOYER_AUTH_SECRET). */
const SECRET = "x".repeat(32);

/** A valid metered Pricing the route accepts. */
const PRICING = {
  model: "metered" as const,
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1048576,
};

/** A minimal LiveDeployResult the fake deploy resolves with. */
const STUB_RESULT: LiveDeployResult = {
  url: "https://gen.resources.example/echo",
  unpaidStatus: 402,
  paidStatus: 200,
  nonAllowlistedUnreachable: false,
  alreadyActive: false,
};

/** The BENIGN fixture SOURCE (never imported or executed). */
function benignHandlerSource(): string {
  return readFileSync(resolve(HERE, "fixtures/generated-benign/handler.ts"), "utf8");
}

/** A valid request body for the given slug + label. */
function bodyFor(slug: string, label: string): DeployRequest {
  return {
    bundle: {
      "handler.ts": benignHandlerSource(),
      "openapi.json": JSON.stringify({ openapi: "3.1.0", paths: { "/echo": {} } }),
    },
    slug,
    resourceLabel: label,
    pricing: PRICING,
  };
}

/** The resourceId the route derives for the default body (label over slug). */
const OWN_RESOURCE_ID = resourceIdForLabel("gen-label");

/** n distinct OTHER-resource census entries. */
function others(
  n: number,
  running = true,
): Array<{ resourceId: string; running: boolean }> {
  return Array.from({ length: n }, (_, i) => ({
    resourceId: `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`,
    running,
  }));
}

/** A fake deploy that emits a terminal done frame and resolves. */
function makeFakeDeploy() {
  return vi.fn(
    async (
      _req: DeployRequest,
      onProgress: (e: DeployProgressEvent) => void,
    ): Promise<LiveDeployResult> => {
      onProgress({ phase: "done", status: "ok", message: "done", result: STUB_RESULT });
      return STUB_RESULT;
    },
  );
}

/** Parse an SSE response body into its DeployProgressEvent `data:` frames. */
async function readSseEvents(res: Response): Promise<DeployProgressEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as DeployProgressEvent);
}

/** POST /deploy with the valid Bearer and a JSON body. */
async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/deploy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

/** GET /deployments with the valid Bearer. */
async function getDeployments(app: Hono): Promise<Response> {
  return app.request("/deployments", {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

describe("POST /deploy capacity admission (PART D1)", () => {
  it("admits under cap: running + inFlight + 2 <= max deploys fine (exact boundary)", async () => {
    const fake = makeFakeDeploy();
    // 4 running others + 0 inFlight + 2 = 6, NOT > 6 -> admit at the exact boundary.
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 6, listRunning: async () => others(4) },
    });
    const res = await post(app, bodyFor("gen", "gen-label"));
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    expect(events.at(-1)!.phase).toBe("done");
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("denies at cap with the EXACT 503 body + Retry-After 60; deploy NOT called; nothing recorded", async () => {
    const fake = makeFakeDeploy();
    // 4 running others + 0 inFlight + 2 = 6 > 5 -> deny.
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 5, listRunning: async () => others(4) },
    });
    const res = await post(app, bodyFor("gen", "gen-label"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    const json = (await res.json()) as { error: string };
    // The retry hint MUST live in the error string (the studio surfaces only that)
    // and stay distinct from the auth-unset 503 string.
    expect(json.error).toBe("host at capacity, retry in ~60s");
    expect(fake).toHaveBeenCalledTimes(0);
    // Pre-stream deny: no record was ever written.
    const records = (await (await getDeployments(app)).json()) as unknown[];
    expect(records).toEqual([]);
  });

  it("same-resourceId redeploy admits AT cap (own pair excluded from the running count)", async () => {
    const fake = makeFakeDeploy();
    // The host is full at cap 4: this resource's own live pair + 2 others. Excluding
    // the own pair leaves 2 running, and 2 + 0 + 2 = 4, NOT > 4 -> the redeploy admits.
    const census = [
      { resourceId: OWN_RESOURCE_ID, running: true },
      { resourceId: OWN_RESOURCE_ID, running: true },
      ...others(2),
    ];
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 4, listRunning: async () => census },
    });
    const res = await post(app, bodyFor("gen", "gen-label"));
    expect(res.status).toBe(200);
    await res.text();
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("counts only RUNNING containers (stopped ones do not block admission)", async () => {
    const fake = makeFakeDeploy();
    // 10 stopped others on a cap-2 host: 0 running + 0 + 2 = 2, NOT > 2 -> admit.
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 2, listRunning: async () => others(10, false) },
    });
    const res = await post(app, bodyFor("gen", "gen-label"));
    expect(res.status).toBe(200);
    await res.text();
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("listRunning THROW fails closed: pre-stream 503, deploy NOT called", async () => {
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: {
        maxContainers: 20,
        listRunning: async () => {
          throw new Error("docker socket gone");
        },
      },
    });
    const res = await post(app, bodyFor("gen", "gen-label"));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("capacity check failed, retry shortly");
    expect(fake).toHaveBeenCalledTimes(0);
  });

  it("listRunning HANG fails closed after the 5s census timeout: same 503, deploy NOT called", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeDeploy();
      const app = createDeployerApp({
        stores: createInMemoryStores(),
        authSecret: SECRET,
        deploy: fake,
        // Never settles: only the census timeout can resolve the request.
        capacity: { maxContainers: 20, listRunning: () => new Promise(() => {}) },
      });
      const resPromise = post(app, bodyFor("gen", "gen-label"));
      await vi.advanceTimersByTimeAsync(5000);
      const res = await resPromise;
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("capacity check failed, retry shortly");
      expect(fake).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /deploy in-flight reservation lifecycle (PART D1)", () => {
  it("holds 2 slots while a deploy is in flight (concurrent deploy denied) and releases them on success", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = vi.fn(
      async (
        _req: DeployRequest,
        onProgress: (e: DeployProgressEvent) => void,
      ): Promise<LiveDeployResult> => {
        await gate;
        onProgress({ phase: "done", status: "ok", message: "done", result: STUB_RESULT });
        return STUB_RESULT;
      },
    );
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 2, listRunning: async () => [] },
    });

    // First deploy admits (0 + 0 + 2 = 2, not > 2) and hangs on the gate.
    const res1 = await post(app, bodyFor("gen", "gen-label"));
    expect(res1.status).toBe(200);

    // While it is in flight its 2 slots are held: a second deploy is denied.
    const res2 = await post(app, bodyFor("gen2", "gen2-label"));
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as { error: string }).error).toBe(
      "host at capacity, retry in ~60s",
    );

    // Complete the first deploy and drain its stream: the slots are released.
    release();
    await res1.text();
    const res3 = await post(app, bodyFor("gen2", "gen2-label"));
    expect(res3.status).toBe(200);
    await res3.text();
  });

  it("does NOT double-count an in-flight deploy already in the census (no silent capacity halving)", async () => {
    // Deploy A admits and hangs (reservation held). Once A's 2 containers ALSO appear
    // in the live census, a second deploy B must count A ONCE (via the reservation),
    // not twice (reservation + census). With maxContainers=4: excluding reserved A
    // from the census leaves running=0, so 0 + inFlight(2) + 2 = 4 -> B admits. The
    // pre-fix double-count would compute 2 + 2 + 2 = 6 > 4 and spuriously 503 B.
    let aInFlight = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = vi.fn(
      async (
        req: DeployRequest,
        onProgress: (e: DeployProgressEvent) => void,
      ): Promise<LiveDeployResult> => {
        if (req.slug === "gen") await gate; // A hangs so its reservation stays held
        onProgress({ phase: "done", status: "ok", message: "done", result: STUB_RESULT });
        return STUB_RESULT;
      },
    );
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: {
        maxContainers: 4,
        // Before A is in flight the host is empty; once A is reserved its pair shows
        // up in the census (WRITE-THEN-LAUNCH), which is exactly the double-count window.
        listRunning: async () =>
          aInFlight
            ? [
                { resourceId: OWN_RESOURCE_ID, running: true },
                { resourceId: OWN_RESOURCE_ID, running: true },
              ]
            : [],
      },
    });

    // A admits (0 + 0 + 2 = 2 <= 4) and hangs; mark its containers now live.
    const resA = await post(app, bodyFor("gen", "gen-label"));
    expect(resA.status).toBe(200);
    aInFlight = true;

    // B (a DIFFERENT resource) must still admit: A is counted once via the reservation.
    const resB = await post(app, bodyFor("gen2", "gen2-label"));
    expect(resB.status).toBe(200);
    await resB.text();

    release();
    await resA.text();
  });

  it("releases the slots when the deploy THROWS (a follow-up deploy is not spuriously denied)", async () => {
    const fake = vi.fn(async (): Promise<LiveDeployResult> => {
      throw new Error("simulated deploy failure");
    });
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 2, listRunning: async () => [] },
    });

    const res1 = await post(app, bodyFor("gen", "gen-label"));
    expect(res1.status).toBe(200);
    const events = await readSseEvents(res1);
    expect(events.some((e) => e.status === "error")).toBe(true);

    // The failed deploy released its slots: the next deploy admits.
    const res2 = await post(app, bodyFor("gen", "gen-label"));
    expect(res2.status).toBe(200);
    await res2.text();
  });

  it("releases the slots on the SlugConflictError early return", async () => {
    const stores = createInMemoryStores();
    // Pre-claim slug "gen" under a DIFFERENT resourceId so the pre-launch write
    // throws SlugConflictError (M5) and the callback early-returns.
    const otherResource: `0x${string}` = `0x${"b3".repeat(32)}`;
    await stores.deployments.put({
      agentId: otherResource,
      resourceId: otherResource,
      slug: "gen",
      deployVersion: 1,
      status: "running",
      updatedAt: 1_000,
    });
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores,
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 2, listRunning: async () => [] },
    });

    const res1 = await post(app, bodyFor("gen", "gen-label"));
    expect(res1.status).toBe(200);
    const events = await readSseEvents(res1);
    expect(events.some((e) => e.status === "error")).toBe(true);
    expect(fake).toHaveBeenCalledTimes(0);

    // The early return still released the slots: a NON-conflicting deploy admits.
    const res2 = await post(app, bodyFor("gen2", "gen2-label"));
    expect(res2.status).toBe(200);
    await res2.text();
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("hard deadline: a hung deploy times out into the error frame, flips the record to failed, and releases the slots", async () => {
    let calls = 0;
    const fake = vi.fn(
      async (
        _req: DeployRequest,
        onProgress: (e: DeployProgressEvent) => void,
      ): Promise<LiveDeployResult> => {
        calls++;
        // The FIRST deploy hangs forever (the deadline must collect it); later
        // deploys complete normally so the release proof does not hang too.
        if (calls === 1) return new Promise<never>(() => {});
        onProgress({ phase: "done", status: "ok", message: "done", result: STUB_RESULT });
        return STUB_RESULT;
      },
    );
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      capacity: { maxContainers: 2, listRunning: async () => [] },
      deployTimeoutMs: 25,
    });

    const res1 = await post(app, bodyFor("gen", "gen-label"));
    expect(res1.status).toBe(200);
    const events = await readSseEvents(res1);
    const errorEvent = events.find((e) => e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain("deploy timed out after 25ms");

    // The record flipped to failed (the existing catch path ran).
    const records = (await (await getDeployments(app)).json()) as Array<{ status: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");

    // The expiry released the slots: the next deploy admits and completes.
    const res2 = await post(app, bodyFor("gen", "gen-label"));
    expect(res2.status).toBe(200);
    const events2 = await readSseEvents(res2);
    expect(events2.at(-1)!.phase).toBe("done");
  });

  it("NO capacity dep: no admission check and NO deadline (dev/test behavior unchanged)", async () => {
    // deployTimeoutMs is set but capacity is absent: the deadline must NOT apply
    // (it exists only to release reserved slots), so a deploy slower than the
    // timeout still completes with done.
    const fake = vi.fn(
      async (
        _req: DeployRequest,
        onProgress: (e: DeployProgressEvent) => void,
      ): Promise<LiveDeployResult> => {
        await new Promise((r) => setTimeout(r, 30));
        onProgress({ phase: "done", status: "ok", message: "done", result: STUB_RESULT });
        return STUB_RESULT;
      },
    );
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
      deployTimeoutMs: 5,
    });
    const res = await post(app, bodyFor("gen", "gen-label"));
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    const events = await readSseEvents(res);
    expect(events.at(-1)!.phase).toBe("done");
    expect(events.at(-1)!.status).toBe("ok");
  });
});

describe("parsePositiveInt (the env parse guard)", () => {
  it("falls back on unset/blank/garbage/zero/negative and accepts a real positive value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Unset/blank: the normal unconfigured case, silent fallback.
      expect(parsePositiveInt(undefined, 20, "K")).toBe(20);
      expect(parsePositiveInt("", 20, "K")).toBe(20);
      expect(parsePositiveInt("   ", 20, "K")).toBe(20);
      expect(warn).toHaveBeenCalledTimes(0);
      // Set but invalid: fallback + a one-line warning (the "5O" typo trap).
      expect(parsePositiveInt("abc", 20, "K")).toBe(20);
      expect(parsePositiveInt("0", 20, "K")).toBe(20);
      expect(parsePositiveInt("-3", 20, "K")).toBe(20);
      expect(warn).toHaveBeenCalledTimes(3);
      // A real value wins over the fallback (trim tolerated).
      expect(parsePositiveInt("20", 7, "K")).toBe(20);
      expect(parsePositiveInt(" 20 ", 7, "K")).toBe(20);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /deployments Bearer gate (PART D4)", () => {
  it("503 when DEPLOYER_AUTH_SECRET is unset (fail closed, distinct error string)", async () => {
    const app = createDeployerApp({ stores: createInMemoryStores() });
    const res = await app.request("/deployments");
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("DEPLOYER_AUTH_SECRET");
  });

  it("401 on a missing or wrong Bearer", async () => {
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
    });
    const missing = await app.request("/deployments");
    expect(missing.status).toBe(401);
    const wrong = await app.request("/deployments", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
  });

  it("200 with the correct Bearer (the read-through still works)", async () => {
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
    });
    const res = await getDeployments(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
