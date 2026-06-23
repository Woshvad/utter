// live-submit-payment.test.ts - the real client-side x402 transport (260623-deq).
//
// These lock the MONEY-PATH wire contract for liveSubmitPayment + the live selector:
//   - the POST goes to `${resourceUrl}/call` with the X-PAYMENT header and the request body
//   - NO X-IDEM-KEY rides the live wire (the idemKey is carried inside the X-PAYMENT payload)
//   - the X-PAYMENT-RESPONSE settlement receipt is browser-decoded base64 JSON; its `amount`
//     decimal string becomes the bigint debit (no money literal); absent receipt -> 0n debit
//   - a non-200 means NOT paid and rejects
//   - the selector returns the real transport when a resourceUrl is configured, else fail-loud
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  liveSubmitPayment,
  selectSubmitPayment,
  RequiresLivePaymentError,
} from "../app/wallet/submit-payment";

const IDEM = ("0x" + "ab".repeat(32)) as `0x${string}`;
const RESOURCE_URL = "https://demo.resources.example";

/** Browser-style base64 of a UTF-8 JSON string (the X-PAYMENT-RESPONSE wire encoding). */
function b64Json(obj: unknown): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("liveSubmitPayment - the real x402 transport (260623-deq)", () => {
  it("POSTs X-PAYMENT to ${resourceUrl}/call with the body and decodes the receipt amount", async () => {
    const receipt = b64Json({ amount: "5300", tx: "0xdeadbeef" });
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ echo: "ok" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-PAYMENT-RESPONSE": receipt,
          },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const submit = liveSubmitPayment({
      resourceUrl: RESOURCE_URL,
      getRequestBody: () => ({ text: "hello" }),
    });
    const result = await submit("ENCODED_HEADER", IDEM);

    expect(result.paid).toBe(true);
    // the settled debit is read ONLY from the receipt decimal string -> BigInt
    expect(result.debitAmount).toBe(5300n);
    expect(result.body).toEqual({ echo: "ok" });
    expect(result.bodyBytes).toBeGreaterThan(0);

    // wire assertions
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${RESOURCE_URL}/call`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PAYMENT"]).toBe("ENCODED_HEADER");
    expect(headers["Content-Type"]).toBe("application/json");
    // NO X-IDEM-KEY on the live wire (it rides inside the X-PAYMENT payload)
    expect(headers["X-IDEM-KEY"]).toBeUndefined();
    // the body is the JSON of getRequestBody() (the same body that triggered the 402)
    expect(init.body).toBe(JSON.stringify({ text: "hello" }));
  });

  it("a 200 with NO X-PAYMENT-RESPONSE still paid, with a 0n debit", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const submit = liveSubmitPayment({
      resourceUrl: RESOURCE_URL,
      getRequestBody: () => ({ a: 1 }),
    });
    const result = await submit("HEADER", IDEM);
    expect(result.paid).toBe(true);
    expect(result.debitAmount).toBe(0n);
  });

  it("a non-200 (402 verify-fail) rejects - the call was NOT paid", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => new Response("nope", { status: 402 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const submit = liveSubmitPayment({
      resourceUrl: RESOURCE_URL,
      getRequestBody: () => null,
    });
    await expect(submit("HEADER", IDEM)).rejects.toThrow(/402/);
  });

  it("an overridable path replaces the default /call", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const submit = liveSubmitPayment({
      resourceUrl: RESOURCE_URL,
      getRequestBody: () => null,
      path: "/run",
    });
    await submit("HEADER", IDEM);
    const [url] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${RESOURCE_URL}/run`);
  });

  it("browser base64 decode is correct for a known receipt", async () => {
    // a real base64 of a known JSON, decoded the same way the transport does
    const known = b64Json({ amount: "777", tx: "0xabc" });
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response("{}", {
          status: 200,
          headers: { "X-PAYMENT-RESPONSE": known },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const submit = liveSubmitPayment({
      resourceUrl: RESOURCE_URL,
      getRequestBody: () => null,
    });
    const result = await submit("HEADER", IDEM);
    expect(result.debitAmount).toBe(777n);
  });
});

describe("selectSubmitPayment - live mode gating (260623-deq)", () => {
  it("mode:'live' with a resourceUrl + getRequestBody returns the real transport", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const submit = selectSubmitPayment({
      resourceId: "0xres",
      mode: "live",
      resourceUrl: RESOURCE_URL,
      getRequestBody: () => ({ q: "x" }),
    });
    const result = await submit("HEADER", IDEM);
    expect(result.paid).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${RESOURCE_URL}/call`);
  });

  it("mode:'live' with NO resourceUrl throws RequiresLivePaymentError (fail-loud, no fetch)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const submit = selectSubmitPayment({
      resourceId: "0xres",
      mode: "live",
      getRequestBody: () => ({ q: "x" }),
    });
    await expect(submit("HEADER", IDEM)).rejects.toBeInstanceOf(RequiresLivePaymentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mode:'live' with a resourceUrl but NO getRequestBody is fail-loud", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const submit = selectSubmitPayment({
      resourceId: "0xres",
      mode: "live",
      resourceUrl: RESOURCE_URL,
    });
    await expect(submit("HEADER", IDEM)).rejects.toBeInstanceOf(RequiresLivePaymentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mode absent/'fixture' returns the fixture submitter (unchanged behavior)", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ paid: true, debitAmount: "12000", body: { echo: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const submit = selectSubmitPayment({ resourceId: "0xres", mode: "fixture" });
    const result = await submit("HEADER", IDEM);
    // the fixture path POSTs back through the route action and carries X-IDEM-KEY
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/resources/0xres");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-IDEM-KEY"]).toBe(IDEM);
    expect(result.debitAmount).toBe(12000n);
  });
});
