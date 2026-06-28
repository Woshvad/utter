// server.test.ts - the AUTONOMOUS POST /deploy endpoint proofs (NO docker, NO chain,
// NO host). They drive createDeployerApp with an INJECTED fake deploy and assert the
// authenticated, gate-first, trust-boundary, happy-path, and error behavior of the new
// SSE endpoint WITHOUT ever running a real deploy.
//
//   (a) 503 when DEPLOYER_AUTH_SECRET is unset (fail closed); deploy NOT called.
//   (b) 401 on a missing/wrong Bearer; deploy NOT called.
//   (c) 400 + GATE: a MALICIOUS bundle is rejected pre-stream; deploy NOT called.
//   (d) 400 on a missing handler.ts / invalid slug / missing pricing; deploy NOT called.
//   (e) HAPPY: a benign bundle streams the phase sequence ending in done; deploy called
//       once with the REQUEST's trusted slug/pricing/label + the bundle's own openapi.
//   (f) ERROR: a rejecting deploy emits an error frame; the secret/stack are not leaked.
//
// The malicious fixture (services/sandbox/test/fixtures/malicious/handler.ts) is read
// SOURCE-ONLY and never imported or executed.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { createDeployerApp, type DeployRequest } from "../src/server";
import { createInMemoryStores } from "../src/stores/memory";
import { resourceIdForLabel } from "@utter/x402-arc";
import type { DeployProgressEvent, LiveDeployResult } from "../src/live-deploy";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A >=32-char shared secret (the route requires a non-blank DEPLOYER_AUTH_SECRET). */
const SECRET = "x".repeat(32);

/** A valid metered Pricing the route accepts (string base/perKB/computeMultiplier). */
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

/** The MALICIOUS fixture SOURCE (read-only; never imported or executed). */
function maliciousHandlerSource(): string {
  return readFileSync(
    resolve(HERE, "../../sandbox/test/fixtures/malicious/handler.ts"),
    "utf8",
  );
}

/** The BENIGN fixture SOURCE (the dir holds ONLY handler.ts; openapi is inline). */
function benignHandlerSource(): string {
  return readFileSync(resolve(HERE, "fixtures/generated-benign/handler.ts"), "utf8");
}

/**
 * A fake deploy: a vi.fn that emits the canned phase sequence (each step running then
 * ok, then a terminal done with STUB_RESULT) and resolves with STUB_RESULT. It runs NO
 * docker, chain, or host.
 */
function makeFakeDeploy() {
  return vi.fn(
    async (
      _req: DeployRequest,
      onProgress: (e: DeployProgressEvent) => void,
    ): Promise<LiveDeployResult> => {
      for (const phase of ["register", "build", "launch", "route", "verify", "probe"] as const) {
        onProgress({ phase, status: "running", message: `${phase} running` });
        onProgress({ phase, status: "ok", message: `${phase} ok` });
      }
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

/** POST /deploy with an optional Bearer and a JSON body. */
async function post(
  app: Hono,
  opts: { bearer?: string; body: unknown },
): Promise<Response> {
  return app.request("/deploy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: JSON.stringify(opts.body),
  });
}

/** A valid benign request body (handler.ts + an inline openapi). */
function benignBody(): DeployRequest {
  return {
    bundle: {
      "handler.ts": benignHandlerSource(),
      "openapi.json": JSON.stringify({ openapi: "3.1.0", paths: { "/echo": {} } }),
    },
    slug: "gen",
    resourceLabel: "gen-label",
    pricing: PRICING,
  };
}

describe("POST /deploy auth fail-closed (T-ny2-01/02)", () => {
  it("(a) 503 when DEPLOYER_AUTH_SECRET is unset; deploy NOT called", async () => {
    const fake = makeFakeDeploy();
    // authSecret omitted (undefined) -> the route fails closed.
    const app = createDeployerApp({ stores: createInMemoryStores(), deploy: fake });
    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(503);
    expect(fake).toHaveBeenCalledTimes(0);
  });

  it("(b) 401 on a missing/wrong Bearer; deploy NOT called", async () => {
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });

    // No Authorization header at all.
    const noHeader = await app.request("/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(benignBody()),
    });
    expect(noHeader.status).toBe(401);

    // A wrong bearer.
    const wrong = await post(app, { bearer: "wrong", body: benignBody() });
    expect(wrong.status).toBe(401);

    expect(fake).toHaveBeenCalledTimes(0);
  });
});

describe("POST /deploy pre-stream gate (T-ny2-05)", () => {
  it("(c) 400 rejects a MALICIOUS bundle and never calls deploy", async () => {
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });
    const res = await post(app, {
      bearer: SECRET,
      body: {
        bundle: { "handler.ts": maliciousHandlerSource() },
        slug: "gen",
        pricing: PRICING,
      },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; violations: string[] };
    expect(json.error).toBe("bundle rejected");
    expect(Array.isArray(json.violations)).toBe(true);
    expect(json.violations.length).toBeGreaterThan(0);
    // The malicious fixture enumerates process.env AND imports `net`; the gate must
    // name an env-enumeration / dangerous-import violation (substring, not an exact id).
    const joined = json.violations.join(" ").toLowerCase();
    expect(joined).toMatch(/env|import|net|secret|dangerous/);
    expect(fake).toHaveBeenCalledTimes(0);
  });
});

describe("POST /deploy body validation (T-ny2-07)", () => {
  it("(d) 400 on missing handler.ts, invalid slug, or missing pricing; deploy NOT called", async () => {
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });

    // (i) missing handler.ts (only an openapi.json present).
    const noHandler = await post(app, {
      bearer: SECRET,
      body: {
        bundle: { "openapi.json": JSON.stringify({ openapi: "3.1.0", paths: {} }) },
        slug: "gen",
        pricing: PRICING,
      },
    });
    expect(noHandler.status).toBe(400);

    // (ii) invalid slug (dotted / non-dns).
    const badSlug = await post(app, {
      bearer: SECRET,
      body: {
        bundle: { "handler.ts": benignHandlerSource() },
        slug: "Bad.Slug",
        pricing: PRICING,
      },
    });
    expect(badSlug.status).toBe(400);

    // (iii) missing pricing.
    const noPricing = await post(app, {
      bearer: SECRET,
      body: {
        bundle: { "handler.ts": benignHandlerSource() },
        slug: "gen",
      },
    });
    expect(noPricing.status).toBe(400);

    expect(fake).toHaveBeenCalledTimes(0);
  });
});

describe("POST /deploy happy path + trust boundary (T-ny2-04)", () => {
  it("(e) 200 streams the phase sequence ending in done; deploy gets the trusted request", async () => {
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });
    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSseEvents(res);
    const phases = events.map((e) => e.phase);
    // The six steps appear in order, then a terminal done.
    expect(phases.filter((p) => p === "register").length).toBeGreaterThan(0);
    const orderedSteps: DeployProgressEvent["phase"][] = [
      "register",
      "build",
      "launch",
      "route",
      "verify",
      "probe",
    ];
    const firstSeen = orderedSteps.map((p) => phases.indexOf(p));
    for (let i = 1; i < firstSeen.length; i++) {
      expect(firstSeen[i]!).toBeGreaterThan(firstSeen[i - 1]!);
    }
    const last = events.at(-1)!;
    expect(last.phase).toBe("done");
    expect(last.status).toBe("ok");
    expect(last.result).toEqual(STUB_RESULT);

    // TRUST BOUNDARY: deploy ran exactly once and the request carried the TRUSTED
    // slug / pricing / label + the bundle's OWN openapi (never the bundle's choosing of
    // slug/pricing). The resourceId derivation itself is unit-covered by resourceIdForLabel;
    // here assert at the request boundary the default impl will map from.
    expect(fake).toHaveBeenCalledTimes(1);
    const passedReq = fake.mock.calls[0]![0];
    expect(passedReq.slug).toBe("gen");
    expect(passedReq.pricing).toEqual(PRICING);
    expect(passedReq.resourceLabel).toBe("gen-label");
    expect(passedReq.bundle["openapi.json"]).toBe(
      JSON.stringify({ openapi: "3.1.0", paths: { "/echo": {} } }),
    );
    // The label resolves to a stable on-chain id (the mapping increment B relies on).
    expect(resourceIdForLabel("gen-label")).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});

describe("POST /deploy persists the deployment record (Track A subtask 4)", () => {
  it("a successful deploy writes a record GET /deployments returns (running, correct slug + derived resourceId)", async () => {
    const fake = makeFakeDeploy();
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });

    // Before any deploy the read-through is empty.
    const before = await app.request("/deployments");
    expect(await before.json()).toEqual([]);

    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(200);
    // Drain the stream so the best-effort persist (after deploy resolves) has run.
    await res.text();

    const after = await app.request("/deployments");
    const records = (await after.json()) as Array<{
      slug: string;
      resourceId: string;
      status: string;
      deployVersion: number;
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.slug).toBe("gen");
    expect(records[0]!.status).toBe("running");
    // Write-then-launch (subtask 7): a "deploying" v1 record precedes launch, then the
    // success write flips it to "running" via an idempotent redeploy that bumps the
    // version to 2. The load-bearing assertion is status === "running"; the version is 2
    // because the lifecycle now writes twice (deploying then running).
    expect(records[0]!.deployVersion).toBe(2);
    // The persisted resourceId is the SAME derivation defaultDeploy uses (label over slug).
    expect(records[0]!.resourceId).toBe(resourceIdForLabel("gen-label"));
  });

  it("a deploy that THROWS leaves a failed record (not absent) and still streams the error frame", async () => {
    const fake = vi.fn(async (): Promise<LiveDeployResult> => {
      throw new Error("simulated deploy failure");
    });
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });

    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    expect(events.some((e) => e.status === "error")).toBe(true);

    // Write-then-launch: a "deploying" record preceded the throw, then it was flipped to
    // "failed" so reconcile excludes it from desired-running and reaps any partial
    // containers. The record is present (not absent).
    const after = await app.request("/deployments");
    const records = (await after.json()) as Array<{ status: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");
  });

  it("writes a deploying record BEFORE deploy resolves, then flips it to running on success", async () => {
    // The injected deploy inspects the store WHILE it runs (before resolving) so the test
    // can assert the deploying-then-running transition without timing flakiness.
    const stores = createInMemoryStores();
    let statusDuringDeploy: string | undefined;
    const fake = vi.fn(
      async (
        _req: DeployRequest,
        onProgress: (e: DeployProgressEvent) => void,
      ): Promise<LiveDeployResult> => {
        const records = await stores.deployments.list();
        statusDuringDeploy = records[0]?.status;
        onProgress({ phase: "done", status: "ok", message: "done", result: STUB_RESULT });
        return STUB_RESULT;
      },
    );
    const app = createDeployerApp({ stores, authSecret: SECRET, deploy: fake });

    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(200);
    await res.text();

    // The record existed as "deploying" while deploy ran.
    expect(statusDuringDeploy).toBe("deploying");
    // And it was flipped to "running" after deploy resolved.
    const after = await app.request("/deployments");
    const records = (await after.json()) as Array<{ status: string; deployVersion: number }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("running");
  });

  it("a pre-launch SlugConflictError aborts the deploy: an error frame and ZERO deploy calls", async () => {
    const stores = createInMemoryStores();
    // Pre-claim the request slug ("gen") under a DIFFERENT resourceId so the pre-launch
    // "deploying" write throws SlugConflictError (M5).
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
    const app = createDeployerApp({ stores, authSecret: SECRET, deploy: fake });

    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    // The conflict aborts: an error frame is streamed and deploy was NEVER called.
    expect(events.some((e) => e.status === "error")).toBe(true);
    expect(fake).toHaveBeenCalledTimes(0);

    // The original owner's record is unchanged (still running, no new record added).
    const after = await app.request("/deployments");
    const records = (await after.json()) as Array<{ resourceId: string; status: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.resourceId).toBe(otherResource);
    expect(records[0]!.status).toBe("running");
  });

  it("a store.put failure on a successful deploy still streams done (best-effort persist)", async () => {
    const fake = makeFakeDeploy();
    const stores = createInMemoryStores();
    // Make the desired-state put throw to simulate a store-layer failure.
    stores.deployments.put = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const app = createDeployerApp({ stores, authSecret: SECRET, deploy: fake });

    const res = await post(app, { bearer: SECRET, body: benignBody() });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    // The deploy still completes: the terminal done frame is present despite the store error.
    const last = events.at(-1)!;
    expect(last.phase).toBe("done");
    expect(last.status).toBe("ok");
    // No error frame: a store failure is best-effort, not a deploy failure.
    expect(events.some((e) => e.status === "error")).toBe(false);
  });
});

describe("POST /deploy error frame (T-ny2-06)", () => {
  it("(f) a rejecting deploy emits an error frame and leaks no secret/stack", async () => {
    const fake = vi.fn(async (): Promise<LiveDeployResult> => {
      throw new Error("simulated deploy failure");
    });
    const app = createDeployerApp({
      stores: createInMemoryStores(),
      authSecret: SECRET,
      deploy: fake,
    });
    const res = await post(app, { bearer: SECRET, body: benignBody() });
    // The stream opens (auth + validation + gate all passed) then surfaces the error.
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as DeployProgressEvent);
    const errorEvent = events.find((e) => e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain("simulated deploy failure");
    // No secret leak; no stack-frame marker in the streamed body.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("    at ");
  });
});
