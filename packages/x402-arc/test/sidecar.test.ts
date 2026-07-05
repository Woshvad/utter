// sidecar suite (Security review C1): the standalone SIDECAR gate-server mounts the
// UNCHANGED `requirePayment` gate and reverse-proxies paid routes to a SEPARATE
// gate-less handler container. These prove the load-bearing invariants of the
// off-process gate WITHOUT any docker / network:
//
//   App cases (createSidecarGateApp), both fetchers injected:
//     1. Unpaid PAID route -> 402 with the escrow quote; the handler is NEVER called.
//     2. Paid success -> /verify then /settle; 200; handler body preserved; receipt hdr.
//     3. Paid declared-error (schema'd) -> /release WITHOUT a strikeReason, NO /settle,
//        the handler's HTTP 400 + body preserved (free; no strike).
//     4. Paid malfunction (permissive default, empty body) -> /release WITH a
//        strikeReason, 502, NO /settle.
//     5. Handler fetch REJECTS -> gate maps handler_error: /release "handler_error", 502.
//     6. Handler HANGS past maxTimeoutSeconds -> gate timeout: /release "timeout", 504.
//     7. The proxy STRIPS x-payment + authorization and PRESERVES method/path/query/
//        body/content-type when reaching the handler.
//     8. A FREE path (agent-card) bypasses the gate entirely: NO /verify, proxied, 200.
//     9. With a facilitatorToken, /verify + /settle + /release carry
//        `Authorization: Bearer <token>`; without it, no auth header.
//
//   loadSidecarConfig cases: required-var fail-fast; pricing mapping; a malformed
//   CLASSIFIER_SCHEMA fails fast (does NOT silently go permissive).
//
// The facilitator stub returns the minimal FetchLike shape ({status, json()}) and
// records which routes were called + the auth header; the handler stub returns a real
// Response (the "container") so Hono sets c.res to it and the gate's clone-read +
// metering are byte-identical to the in-process path.
import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import {
  createSidecarGateApp,
  loadSidecarConfig,
  encodePayment,
  buildClassifier,
  type SidecarConfig,
  type PaymentPayload,
  type Pricing,
  type FetchLike,
  type ResponseClass,
} from "../src/index";
import echoOpenapi from "../examples/echo/openapi.json" with { type: "json" };

const RESOURCE: Hex = `0x${"44".repeat(32)}`;
const BUYER = "0x00000000000000000000000000000000000000aa" as Address;
const MAX_TIMEOUT_SECONDS = 30;
const HANDLER_URL = "http://slug-handler:8080";
const PRICING: Pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
  maxResponseBytes: 1_048_576,
};

/** Records every facilitator route call + the Authorization header seen on each. */
interface FacRecord {
  calls: string[];
  authByPath: Record<string, string | undefined>;
  /** The parsed JSON body of the LAST /release call (to assert strikeReason). */
  lastRelease?: Record<string, unknown>;
}

/** A FetchLike facilitator stub: answers verify/settle/release + records calls/auth. */
function facilitatorStub(rec: FacRecord): FetchLike {
  return async (input, init) => {
    const path = input.includes("/verify")
      ? "verify"
      : input.includes("/settle")
        ? "settle"
        : input.includes("/release")
          ? "release"
          : "other";
    rec.calls.push(path);
    rec.authByPath[path] = init?.headers?.["Authorization"];
    if (path === "release") {
      try {
        rec.lastRelease = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      } catch {
        rec.lastRelease = {};
      }
    }
    if (path === "verify") {
      return { status: 200, json: async () => ({ valid: true }) };
    }
    if (path === "settle") {
      return {
        status: 200,
        json: async () => ({ success: true, receipt: { idemKey: "x", amount: "1" } }),
      };
    }
    return { status: 200, json: async () => ({ released: true }) };
  };
}

/** What the handler stub saw on the proxied request (to assert stripping/preserving). */
interface HandlerRecord {
  called: boolean;
  url?: string;
  method?: string;
  headers?: Headers;
  body?: string;
  contentType?: string;
}

/** Options for the handler container stub. */
interface HandlerStubOpts {
  rec: HandlerRecord;
  status?: number;
  body?: string;
  contentType?: string;
  /** Throw (a connection error) instead of responding. */
  reject?: boolean;
  /** Delay this many ms before responding (to drive the gate timeout). */
  delayMs?: number;
}

/** A `typeof fetch` handler-container stub: records the inbound request, then responds. */
function handlerStub(opts: HandlerStubOpts): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const headers = new Headers(init?.headers);
    opts.rec.called = true;
    opts.rec.url = url;
    opts.rec.method = init?.method;
    opts.rec.headers = headers;
    opts.rec.contentType = headers.get("content-type") ?? undefined;
    if (init?.body) {
      const buf = init.body as ArrayBuffer;
      opts.rec.body = Buffer.from(buf).toString("utf8");
    }
    if (opts.reject) {
      throw new Error("handler container unreachable");
    }
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return new Response(opts.body ?? JSON.stringify({ echo: "hi", length: 2 }), {
      status: opts.status ?? 200,
      headers: { "content-type": opts.contentType ?? "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** A minimal escrow X-PAYMENT header (the gate only decodes its shape in these tests). */
function paymentHeader(nonce: Hex): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "utter-escrow",
    network: "eip155:5042002",
    authorization: {
      buyer: BUYER,
      resourceId: RESOURCE,
      maxAmount: "10000",
      nonce,
      validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    },
    signature: `0x${"00".repeat(65)}`,
  };
  return encodePayment(payload);
}

/** Base sidecar config (overridable per case). */
function cfg(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
  return {
    facilitatorUrl: "http://facilitator.test",
    resourceId: RESOURCE,
    cap: 10_000n,
    pricing: PRICING,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    handlerUrl: HANDLER_URL,
    port: 8080,
    ...overrides,
  };
}

describe("createSidecarGateApp", () => {
  it("1. unpaid PAID route -> 402 with the escrow quote; the handler is NEVER called", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec }),
    });
    const res = await app.request("/call", { method: "POST" });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ scheme: string; maxAmountRequired: string }> };
    expect(body.accepts[0]?.scheme).toBe("utter-escrow");
    expect(body.accepts[0]?.maxAmountRequired).toBe("10000");
    // Free-compute guard: the handler container is never reached without reservation.
    expect(hRec.called).toBe(false);
    expect(fac.calls).not.toContain("verify");
  });

  it("2. paid success -> /verify then /settle, 200, handler body preserved, receipt header", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const handlerBody = JSON.stringify({ echo: "exact-bytes", length: 11 });
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: handlerBody }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"a2".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(handlerBody);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    expect(fac.calls).toContain("verify");
    expect(fac.calls).toContain("settle");
    expect(fac.calls).not.toContain("release");
  });

  it("3. paid declared-error (schema'd) -> /release WITHOUT strikeReason, no /settle, HTTP 400 + body preserved", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const classifier = buildClassifier(echoOpenapi as Record<string, unknown>);
    const errorBody = JSON.stringify({ error: "bad input", code: "E_INPUT" });
    const app = createSidecarGateApp(cfg({ classifier }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 400, body: errorBody }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"a3".repeat(32)}`) },
    });
    // The declared-error branch serves the ORIGINAL handler response unchanged.
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(errorBody);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    // Free / no-strike: the release carries NO strikeReason.
    expect(fac.lastRelease?.strikeReason).toBeUndefined();
  });

  it("4. paid malfunction (permissive default, empty body) -> /release WITH strikeReason, 502, no /settle", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    // No classifier -> permissive default; an empty body is a malfunction.
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: "" }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"a4".repeat(32)}`) },
    });
    expect(res.status).toBe(502);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    expect(typeof fac.lastRelease?.strikeReason).toBe("string");
  });

  it("5. handler fetch REJECTS -> gate releases WITH a strike, 502, NO settle (never swallowed)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, reject: true }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"a5".repeat(32)}`) },
    });
    // The proxy never catches/swallows the rejection. Hono's compose catches a
    // thrown DOWNSTREAM handler and resolves next() with a 500 "Internal Server
    // Error" body (it does NOT reject next()), so the gate classifies that body as a
    // malfunction and releases WITH a strikeReason -> 502, NO debit. The
    // security-critical outcome (release + strike + 502, never charged) is identical
    // to the gate's own handler_error branch; only the strikeReason label differs
    // because the throw reaches the gate as a malfunctioning response, not a rejected
    // next(). This matches the in-process path: requirePayment is reused verbatim and
    // only the transport differs.
    expect(res.status).toBe(502);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    expect(typeof fac.lastRelease?.strikeReason).toBe("string");
  });

  it("6. handler HANGS past maxTimeoutSeconds -> gate timeout: /release 'timeout', 504", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    // A tiny timeout and a slower handler so the gate's withTimeout(next()) fires.
    const app = createSidecarGateApp(cfg({ maxTimeoutSeconds: 0.05 }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, delayMs: 200 }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"a6".repeat(32)}`) },
    });
    expect(res.status).toBe(504);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    expect(fac.lastRelease?.strikeReason).toBe("timeout");
  });

  it("7. the proxy STRIPS x-payment + authorization and PRESERVES method/path/query/body/content-type", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: JSON.stringify({ echo: "x", length: 1 }) }),
    });
    const reqBody = JSON.stringify({ input: "preserve-me" });
    const res = await app.request("/call?q=1&z=two", {
      method: "POST",
      headers: {
        "X-PAYMENT": paymentHeader(`0x${"a7".repeat(32)}`),
        Authorization: "Bearer should-not-leak",
        "content-type": "application/json",
      },
      body: reqBody,
    });
    expect(res.status).toBe(200);
    expect(hRec.called).toBe(true);
    // Stripped before reaching the untrusted handler.
    expect(hRec.headers?.get("x-payment")).toBeNull();
    expect(hRec.headers?.get("authorization")).toBeNull();
    // Preserved.
    expect(hRec.method).toBe("POST");
    expect(hRec.url).toContain("/call");
    expect(hRec.url).toContain("q=1");
    expect(hRec.url).toContain("z=two");
    expect(hRec.body).toBe(reqBody);
    expect(hRec.contentType).toBe("application/json");
  });

  it("8. a FREE path (agent-card) bypasses the gate entirely: NO /verify, proxied, 200", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const cardBody = JSON.stringify({ name: "echo", protocolVersion: "0.3.0" });
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: cardBody }),
    });
    const res = await app.request("/.well-known/agent-card.json", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(cardBody);
    // Discovery is never paywalled: the gate (verify) never runs; the handler is reached.
    expect(fac.calls).toHaveLength(0);
    expect(hRec.called).toBe(true);
  });

  it("8b. with agentCard configured, the sidecar SERVES the card itself (200); the handler is NOT proxied", async () => {
    // The untrusted handler has NO card route, so proxying the free card path to it 404s (the
    // real bug that failed the marketplace publish probe). With a card configured, the TRUSTED
    // sidecar serves it directly, so discovery works without ever touching the handler.
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const card = JSON.stringify({ name: "weather", protocolVersion: "0.3.0" });
    const app = createSidecarGateApp(cfg({ agentCard: card }), {
      facilitatorFetcher: facilitatorStub(fac),
      // The handler would 404 the card path; assert it is NEVER reached.
      handlerFetcher: handlerStub({ rec: hRec, status: 404, body: "not found" }),
    });
    const res = await app.request("/.well-known/agent-card.json", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(card);
    expect(res.headers.get("content-type")).toContain("application/json");
    // The trusted sidecar served it: NO gate (verify) AND the untrusted handler was NOT proxied.
    expect(fac.calls).toHaveLength(0);
    expect(hRec.called).toBe(false);
  });

  it("8c. agentCard is served ONLY on the exact card GET; another free path still proxies", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg({ agentCard: JSON.stringify({ name: "x" }) }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: "ok" }),
    });
    // /healthz is a free path but NOT the card path, so it still bypasses to the handler.
    const res = await app.request("/healthz", { method: "GET" });
    expect(res.status).toBe(200);
    expect(hRec.called).toBe(true);
  });

  it("9. with facilitatorToken set, /verify + /settle + /release carry Bearer <token>", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    // Force the release path too (malfunction) so all three carry the token.
    const app = createSidecarGateApp(cfg({ facilitatorToken: "tok-c1", classifier: () => "success" as ResponseClass }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: JSON.stringify({ ok: true }) }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"a9".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    expect(fac.authByPath.verify).toBe("Bearer tok-c1");
    expect(fac.authByPath.settle).toBe("Bearer tok-c1");
  });

  it("9b. without a token, NO Authorization header is sent to the facilitator", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: JSON.stringify({ ok: true }) }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"ab".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    expect(fac.authByPath.verify).toBeUndefined();
    expect(fac.authByPath.settle).toBeUndefined();
  });

  it("10. free paths are EXACT: a route UNDER /.well-known/* is gated (#3)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec }),
    });
    // NOT an exact free path -> the gate runs; unpaid -> 402; handler NEVER reached.
    const res = await app.request("/.well-known/anything-else", { method: "GET" });
    expect(res.status).toBe(402);
    expect(hRec.called).toBe(false);
    expect(fac.calls).not.toContain("verify");
  });

  it("11. free paths are EXACT: a route UNDER /health (/health/work) is gated (#3)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec }),
    });
    const res = await app.request("/health/work", { method: "GET" });
    expect(res.status).toBe(402);
    expect(hRec.called).toBe(false);
    expect(fac.calls).not.toContain("verify");
  });

  it("12. /healthz (an exact default free path) bypasses the gate; handler reached (#3)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: JSON.stringify({ ok: true }) }),
    });
    const res = await app.request("/healthz", { method: "GET" });
    expect(res.status).toBe(200);
    expect(fac.calls).toHaveLength(0);
    expect(hRec.called).toBe(true);
  });

  it("13. a custom FREE_PATHS list is honored as EXACT entries (#3)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const app = createSidecarGateApp(cfg({ freePaths: ["/ping"] }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: JSON.stringify({ ok: true }) }),
    });
    // The exact custom free path bypasses; a route under it is gated.
    const free = await app.request("/ping", { method: "GET" });
    expect(free.status).toBe(200);
    expect(fac.calls).toHaveLength(0);
    const gated = await app.request("/ping/work", { method: "GET" });
    expect(gated.status).toBe(402);
    // The previous default agent-card is NOT free under a custom list.
    const card = await app.request("/.well-known/agent-card.json", { method: "GET" });
    expect(card.status).toBe(402);
  });

  it("14. the proxy ABORTS the upstream fetch at the gate deadline (#4)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    let sawAbort = false;
    // A handler that observes init.signal and never resolves until aborted.
    const handlerFetch = (async (_input: URL | string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
        }
      });
    }) as unknown as typeof fetch;
    // A tiny gate timeout so withTimeout(next()) and the proxy abort fire together.
    const app = createSidecarGateApp(cfg({ maxTimeoutSeconds: 0.05 }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerFetch,
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"ac".repeat(32)}`) },
    });
    // The gate's own timeout resolves the outcome (504 + release "timeout").
    expect(res.status).toBe(504);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    // The proxy's abort fires at its own deadline (the SAME maxTimeoutSeconds). It may
    // land just after the gate resolves the response (the two timers race), so wait a
    // short, bounded window for the upstream socket to be CANCELLED, not leaked (#4).
    for (let i = 0; i < 50 && !sawAbort; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(sawAbort).toBe(true);
  });

  it("15. an OVERSIZE handler body -> malfunction: 502 + /release, NO /settle (#5)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    // A body LARGER than the configured cap (1 MiB in PRICING). Use a 200 + valid
    // JSON so ONLY the size cap can trip the malfunction (not the classifier).
    const huge = JSON.stringify({ data: "x".repeat(1_048_576 + 1024) });
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: huge }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"ad".repeat(32)}`) },
    });
    // Oversize is a malfunction: never settled (no debit), released with a strike, 502.
    expect(res.status).toBe(502);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    expect(typeof fac.lastRelease?.strikeReason).toBe("string");
  });

  it("16. an IN-CAP body -> 200 + /settle; body + receipt preserved (#5)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const inCap = JSON.stringify({ echo: "small", length: 5 });
    const app = createSidecarGateApp(cfg(), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 200, body: inCap }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"ae".repeat(32)}`) },
    });
    expect(res.status).toBe(200);
    // The bounded read preserves the body byte-identically and the receipt is set.
    expect(await res.text()).toBe(inCap);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    expect(fac.calls).toContain("settle");
    expect(fac.calls).not.toContain("release");
  });

  it("17. a declared-error 400 UNDER the cap -> still 400 + free release, no /settle (#5)", async () => {
    const fac: FacRecord = { calls: [], authByPath: {} };
    const hRec: HandlerRecord = { called: false };
    const classifier = buildClassifier(echoOpenapi as Record<string, unknown>);
    const errorBody = JSON.stringify({ error: "bad input", code: "E_INPUT" });
    const app = createSidecarGateApp(cfg({ classifier }), {
      facilitatorFetcher: facilitatorStub(fac),
      handlerFetcher: handlerStub({ rec: hRec, status: 400, body: errorBody }),
    });
    const res = await app.request("/call", {
      method: "POST",
      headers: { "X-PAYMENT": paymentHeader(`0x${"af".repeat(32)}`) },
    });
    // The bounded read preserves the upstream 400 + body so the declared-error branch
    // still fires: free release, no strike, no settle.
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(errorBody);
    expect(fac.calls).toContain("release");
    expect(fac.calls).not.toContain("settle");
    expect(fac.lastRelease?.strikeReason).toBeUndefined();
  });
});

describe("loadSidecarConfig", () => {
  /** A complete, valid env (overridable per case). */
  function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
      FACILITATOR_URL: "http://facilitator.test",
      RESOURCE_ID: RESOURCE,
      CAP: "10000",
      HANDLER_URL: HANDLER_URL,
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  it("fails fast when a required var is missing", () => {
    expect(() => loadSidecarConfig(env({ HANDLER_URL: undefined }))).toThrow(/HANDLER_URL/);
    expect(() => loadSidecarConfig(env({ FACILITATOR_URL: undefined }))).toThrow(/FACILITATOR_URL/);
    expect(() => loadSidecarConfig(env({ RESOURCE_ID: undefined }))).toThrow(/RESOURCE_ID/);
    expect(() => loadSidecarConfig(env({ CAP: undefined }))).toThrow(/CAP/);
  });

  it("maps PRICE_BASE/PRICE_PER_KB/PRICE_MAX to base/perKB/computeMultiplier", () => {
    const resolved = loadSidecarConfig(
      env({ PRICE_BASE: "5000", PRICE_PER_KB: "100", PRICE_MAX: "200" }),
    );
    expect(resolved.pricing).toEqual({
      model: "metered",
      base: "5000",
      perKB: "100",
      computeMultiplier: "200",
    });
    expect(resolved.cap).toBe(10_000n);
    expect(resolved.handlerUrl).toBe(HANDLER_URL);
  });

  it("defaults pricing terms to '0', port to 8080, maxTimeoutSeconds to 30, and the minimal exact free paths", () => {
    const resolved = loadSidecarConfig(env());
    expect(resolved.pricing).toEqual({ model: "metered", base: "0", perKB: "0", computeMultiplier: "0" });
    expect(resolved.port).toBe(8080);
    expect(resolved.maxTimeoutSeconds).toBe(30);
    expect(resolved.freePaths).toEqual(["/.well-known/agent-card.json", "/health", "/healthz"]);
    expect(resolved.pricing.maxResponseBytes).toBeUndefined();
    expect(resolved.facilitatorToken).toBeUndefined();
    expect(resolved.classifier).toBeUndefined();
  });

  it("reads SIDECAR_FACILITATOR_TOKEN and a FREE_PATHS CSV when present", () => {
    const resolved = loadSidecarConfig(
      env({ SIDECAR_FACILITATOR_TOKEN: "tok-xyz", FREE_PATHS: "/.well-known/, /status ,/ping" }),
    );
    expect(resolved.facilitatorToken).toBe("tok-xyz");
    expect(resolved.freePaths).toEqual(["/.well-known/", "/status", "/ping"]);
  });

  it("reads a valid AGENT_CARD_JSON into agentCard; absent -> undefined; malformed -> throws", () => {
    const card = JSON.stringify({ name: "weather", protocolVersion: "0.3.0" });
    expect(loadSidecarConfig(env({ AGENT_CARD_JSON: card })).agentCard).toBe(card);
    // Absent -> the card path proxies as before (undefined).
    expect(loadSidecarConfig(env()).agentCard).toBeUndefined();
    // Malformed JSON fails fast at boot rather than serving garbage the discovery probe rejects.
    expect(() => loadSidecarConfig(env({ AGENT_CARD_JSON: "{not json" }))).toThrow(/AGENT_CARD_JSON/);
  });

  it("compiles CLASSIFIER_SCHEMA into a strict classifier when valid", () => {
    const resolved = loadSidecarConfig(env({ CLASSIFIER_SCHEMA: JSON.stringify(echoOpenapi) }));
    expect(typeof resolved.classifier).toBe("function");
    expect(resolved.classifier?.(JSON.stringify({ echo: "hi", length: 2 }))).toBe("success");
    expect(resolved.classifier?.(JSON.stringify({ error: "bad" }))).toBe("declared_error");
  });

  it("compiles a generated ResourceSuccess/ResourceError CLASSIFIER_SCHEMA (the live studio->deployer path)", () => {
    // The scaffold-shaped openapi a generated bundle ships: no explicit refs, no
    // Echo* schemas. buildClassifier discovers the *Success/*Error refs by suffix so
    // loadSidecarConfig loads without throwing and maps { result, length } -> success.
    const generatedSchema = JSON.stringify({
      $id: "openapi.json",
      openapi: "3.1.0",
      info: { title: "Resource", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          ResourceSuccess: {
            type: "object",
            additionalProperties: false,
            required: ["result", "length"],
            properties: {
              result: { type: "string" },
              length: { type: "integer", minimum: 0 },
            },
          },
          ResourceError: {
            type: "object",
            additionalProperties: false,
            required: ["error"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
        },
      },
    });
    const resolved = loadSidecarConfig(env({ CLASSIFIER_SCHEMA: generatedSchema }));
    expect(typeof resolved.classifier).toBe("function");
    expect(resolved.classifier?.(JSON.stringify({ result: "hi", length: 2 }))).toBe("success");
    expect(resolved.classifier?.(JSON.stringify({ error: "bad", code: "X" }))).toBe(
      "declared_error",
    );
  });

  it("parses MAX_RESPONSE_BYTES into pricing.maxResponseBytes when a positive integer (#2-read)", () => {
    const resolved = loadSidecarConfig(env({ MAX_RESPONSE_BYTES: "65536" }));
    expect(resolved.pricing.maxResponseBytes).toBe(65536);
  });

  it("leaves pricing.maxResponseBytes undefined when MAX_RESPONSE_BYTES is absent (#2-read)", () => {
    const resolved = loadSidecarConfig(env());
    expect(resolved.pricing.maxResponseBytes).toBeUndefined();
  });

  it("ignores a non-positive or non-integer MAX_RESPONSE_BYTES (leaves it undefined) (#2-read)", () => {
    expect(loadSidecarConfig(env({ MAX_RESPONSE_BYTES: "0" })).pricing.maxResponseBytes).toBeUndefined();
    expect(loadSidecarConfig(env({ MAX_RESPONSE_BYTES: "-5" })).pricing.maxResponseBytes).toBeUndefined();
    expect(loadSidecarConfig(env({ MAX_RESPONSE_BYTES: "1.5" })).pricing.maxResponseBytes).toBeUndefined();
    expect(loadSidecarConfig(env({ MAX_RESPONSE_BYTES: "abc" })).pricing.maxResponseBytes).toBeUndefined();
  });

  it("FAILS FAST on a malformed CLASSIFIER_SCHEMA (does not silently go permissive)", () => {
    expect(() => loadSidecarConfig(env({ CLASSIFIER_SCHEMA: "{ not json" }))).toThrow(/CLASSIFIER_SCHEMA/);
    // A well-formed JSON that is NOT a valid schema doc (missing the required schemas)
    // must also fail fast at buildClassifier, not fall back to permissive.
    expect(() => loadSidecarConfig(env({ CLASSIFIER_SCHEMA: JSON.stringify({ openapi: "3.1.0" }) }))).toThrow(
      /CLASSIFIER_SCHEMA/,
    );
  });
});
