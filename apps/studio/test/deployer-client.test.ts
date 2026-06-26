// deployer-client.test.ts - the offline deterministic streamDeploy test.
//
// Stubs global fetch with a Response whose body is a web ReadableStream emitting the
// deployer's `data:{json}\n\n` SSE frames (chunked across reads to exercise the buffer
// split), then asserts streamDeploy maps the phases to the right BuildStages, passes the
// status through, returns on `done`, throws on `error` and a non-ok response, sends the
// Authorization: Bearer + JSON body, and NEVER leaks the bearer into a yielded log or a
// thrown message. No network, no new dependency.
import { describe, it, expect, afterEach } from "vitest";
import { streamDeploy, type DeployBundleParams } from "../app/adapter/deployer-client.server";
import type { Bundle } from "@utter/ai-runtime";
import type { Pricing } from "@utter/x402-arc";
import type { BuildEvent } from "../app/adapter/types";

/** The fake bearer. A successful frame log must never contain this string. */
const SECRET = "test-deployer-secret-at-least-32-chars-long";
const DEPLOYER_URL = "https://deployer.example.com";

/** A minimal bundle (handler.ts required by the wire contract). */
const BUNDLE: Bundle = { "handler.ts": "export default () => {}" };

/** The conservative pricing the studio sends (mirrors live.ts deployerPricing). */
const PRICING: Pricing = {
  model: "metered",
  base: "10000",
  perKB: "0",
  computeMultiplier: "0",
  maxResponseBytes: 1048576,
};

function makeParams(overrides: Partial<DeployBundleParams> = {}): DeployBundleParams {
  return {
    bundle: BUNDLE,
    slug: "echo",
    resourceLabel: "utter:resource:echo",
    pricing: PRICING,
    ...overrides,
  };
}

/** The happy-path progress frames the deployer streams, in order. */
const HAPPY_FRAMES = [
  { phase: "register", status: "running", message: "registering identity" },
  { phase: "register", status: "ok", message: "identity registered" },
  { phase: "build", status: "running", message: "building image" },
  { phase: "build", status: "ok", message: "image built" },
  { phase: "launch", status: "ok", message: "sandbox launched" },
  { phase: "route", status: "ok", message: "route wired" },
  { phase: "verify", status: "running", message: "verifying gates" },
  { phase: "verify", status: "ok", message: "gates passed" },
  { phase: "probe", status: "ok", message: "probe ok" },
  { phase: "done", status: "ok", message: "deploy complete" },
] as const;

/**
 * Build a Response whose body is a web ReadableStream emitting the given frames as
 * `data:{json}\n\n`. The frames are chunked across reads (each frame split into two
 * enqueues at an arbitrary mid-point) so the parser's buffer-split path is exercised.
 */
function makeSseResponse(frames: readonly unknown[], init: { ok?: boolean; status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const text = `data:${JSON.stringify(frame)}\n\n`;
        const mid = Math.floor(text.length / 2);
        controller.enqueue(encoder.encode(text.slice(0, mid)));
        controller.enqueue(encoder.encode(text.slice(mid)));
      }
      controller.close();
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: stream,
  } as unknown as Response;
}

/** Save + restore the global fetch around each case. */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Drain an async generator into an array. */
async function collect(gen: AsyncGenerator<BuildEvent>): Promise<BuildEvent[]> {
  const out: BuildEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("streamDeploy (offline, stubbed fetch SSE)", () => {
  it("maps phases to stages, passes status through, and returns on done", async () => {
    globalThis.fetch = (async () => makeSseResponse(HAPPY_FRAMES)) as typeof fetch;

    const events = await collect(
      streamDeploy(makeParams(), { deployerUrl: DEPLOYER_URL, authSecret: SECRET }),
    );

    // register -> Mint, build/launch/route -> Deploy, verify/probe -> Verify; done emits
    // no event. The order matches the frame order (done is dropped).
    expect(events.map((e) => ({ stage: e.stage, status: e.status }))).toEqual([
      { stage: "Mint", status: "running" },
      { stage: "Mint", status: "ok" },
      { stage: "Deploy", status: "running" },
      { stage: "Deploy", status: "ok" },
      { stage: "Deploy", status: "ok" },
      { stage: "Deploy", status: "ok" },
      { stage: "Verify", status: "running" },
      { stage: "Verify", status: "ok" },
      { stage: "Verify", status: "ok" },
    ]);

    // No yielded log carries the bearer.
    for (const ev of events) {
      expect(ev.log).not.toContain(SECRET);
    }
  });

  it("POSTs to /deploy with Authorization: Bearer and the JSON body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return makeSseResponse(HAPPY_FRAMES);
    }) as unknown as typeof fetch;

    await collect(
      streamDeploy(makeParams(), { deployerUrl: DEPLOYER_URL, authSecret: SECRET }),
    );

    expect(capturedUrl.endsWith("/deploy")).toBe(true);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.slug).toBe("echo");
    expect(body.resourceLabel).toBe("utter:resource:echo");
    expect(body.pricing).toEqual(PRICING);
  });

  it("rejects a 401 with a bearer-free message naming the status", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        async text() {
          return "unauthorized";
        },
      }) as unknown as Response) as typeof fetch;

    const gen = streamDeploy(makeParams(), { deployerUrl: DEPLOYER_URL, authSecret: SECRET });
    await expect(collect(gen)).rejects.toThrow(/401/);
    await expect(
      collect(streamDeploy(makeParams(), { deployerUrl: DEPLOYER_URL, authSecret: SECRET })),
    ).rejects.toThrow(/^(?!.*test-deployer-secret).*$/);
  });

  it("rejects a 400 {error} naming the error string, bearer-free", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ error: "gate violation: secret found" });
        },
      }) as unknown as Response) as typeof fetch;

    let caught: Error | undefined;
    try {
      await collect(streamDeploy(makeParams(), { deployerUrl: DEPLOYER_URL, authSecret: SECRET }));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/400/);
    expect(caught?.message).toMatch(/gate violation/);
    expect(caught?.message).not.toContain(SECRET);
  });

  it("rejects on an error frame with that frame's message", async () => {
    const frames = [
      { phase: "register", status: "ok", message: "identity registered" },
      { phase: "error", status: "error", message: "deploy failed: build timed out" },
    ];
    globalThis.fetch = (async () => makeSseResponse(frames)) as typeof fetch;

    const collected: BuildEvent[] = [];
    let caught: Error | undefined;
    try {
      for await (const ev of streamDeploy(makeParams(), {
        deployerUrl: DEPLOYER_URL,
        authSecret: SECRET,
      })) {
        collected.push(ev);
      }
    } catch (err) {
      caught = err as Error;
    }
    // The register(ok) frame yielded a Mint event before the error frame threw.
    expect(collected[0]?.stage).toBe("Mint");
    expect(caught?.message).toBe("deploy failed: build timed out");
    expect(caught?.message).not.toContain(SECRET);
  });

  it("throws a bearer-free message when the response has no body", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, body: null }) as unknown as Response) as typeof fetch;
    const gen = streamDeploy(makeParams(), { deployerUrl: DEPLOYER_URL, authSecret: SECRET });
    await expect(collect(gen)).rejects.toThrow(/no stream body/);
  });
});
