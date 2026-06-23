// pay-wiring.test.tsx - Task 2 wiring tests (260622-wlu): the PlaygroundPlayer pay seam
// + the submit-payment selector (fixture routes through the action; live is fail-loud).
//
// These assert that:
//   - When onPayWithWallet is PROVIDED, the PaywallSheet pay invokes it (the client
//     wallet path) and streams its result - NOT a second onRun({pay:true}).
//   - When onPayWithWallet is ABSENT, pay falls back to onRun({pay:true}) so the existing
//     server path + existing tests do not regress.
//   - selectSubmitPayment: the fixture submitter POSTs the X-PAYMENT header back through
//     the route action (the in-process facilitator stays server-side); the live submitter
//     throws RequiresLivePaymentError (operator-gated, fail-loud, never a faked call).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import { PlaygroundPlayer } from "../app/components/playground/PlaygroundPlayer";
import {
  selectSubmitPayment,
  fixtureSubmitPayment,
  liveSubmitPayment,
  RequiresLivePaymentError,
} from "../app/wallet/submit-payment";

const METERED_PRICING = {
  model: "metered" as const,
  base: "2000",
  perKB: "500",
  computeMultiplier: "100",
  maxResponseBytes: 1_048_576,
};

const QUOTE = {
  scheme: "utter-escrow" as const,
  network: "eip155:5042002" as const,
  asset: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  escrow: "0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154" as `0x${string}`,
  maxAmountRequired: "50000",
  payTo: "0x00000000000000000000000000000000000000000000000000000000000000a1" as `0x${string}`,
  maxTimeoutSeconds: 30,
  pricing: METERED_PRICING,
};

const UNFUNDED_RESULT = {
  paid: false,
  debitAmount: 0n,
  body: null,
  paywall: { quote: QUOTE },
};

describe("PlaygroundPlayer pay seam (onPayWithWallet provided -> client wallet path)", () => {
  it("invokes onPayWithWallet with the quote on pay and streams its result", async () => {
    const onRun = vi.fn().mockResolvedValue(UNFUNDED_RESULT);
    const onPayWithWallet = vi.fn().mockResolvedValue({
      paid: true,
      debitAmount: 12000n,
      body: { echo: "paid via wallet", length: 5 },
    });
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
        onPayWithWallet={onPayWithWallet}
      />,
    );
    // Run -> 402 paywall
    fireEvent.click(screen.getByTestId("playground-run"));
    await waitFor(() => expect(screen.getByTestId("paywall-sheet")).toBeInTheDocument());

    // Pay -> the CLIENT wallet path (onPayWithWallet), NOT a second onRun.
    fireEvent.click(screen.getByTestId("paywall-pay"));
    await waitFor(() => expect(onPayWithWallet).toHaveBeenCalledTimes(1));
    // it received the paywall quote (the sole price/cap source)
    expect(onPayWithWallet.mock.calls[0]![0]).toMatchObject({ maxAmountRequired: "50000" });
    // onRun was called ONCE (the unpaid GET-402 beat) and never re-run for the pay
    expect(onRun).toHaveBeenCalledTimes(1);
    // the wallet-paid result streams into the response
    await waitFor(() =>
      expect(screen.getByTestId("playground-response").textContent).toContain("paid via wallet"),
    );
  });

  it("keeps the paywall up (for retry) when the wallet pay throws (e.g. rejected popup)", async () => {
    const onRun = vi.fn().mockResolvedValue(UNFUNDED_RESULT);
    const onPayWithWallet = vi.fn().mockRejectedValue(new Error("user rejected"));
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
        onPayWithWallet={onPayWithWallet}
      />,
    );
    fireEvent.click(screen.getByTestId("playground-run"));
    await waitFor(() => expect(screen.getByTestId("paywall-sheet")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("paywall-pay"));
    await waitFor(() => expect(onPayWithWallet).toHaveBeenCalledTimes(1));
    // the paywall stays mounted so the buyer can retry
    await waitFor(() => expect(screen.getByTestId("paywall-sheet")).toBeInTheDocument());
  });
});

describe("PlaygroundPlayer pay seam (onPayWithWallet ABSENT -> server fallback, no regression)", () => {
  it("falls back to onRun({pay:true}) when no wallet seam is wired", async () => {
    // first call (unpaid) -> 402 paywall; second call (pay:true) -> paid
    const onRun = vi
      .fn()
      .mockResolvedValueOnce(UNFUNDED_RESULT)
      .mockResolvedValueOnce({ paid: true, debitAmount: 9000n, body: { echo: "server pay" } });
    render(
      <PlaygroundPlayer
        resourceId="0xabc"
        decimals={6}
        pricing={METERED_PRICING}
        cap={50000n}
        onRun={onRun}
      />,
    );
    fireEvent.click(screen.getByTestId("playground-run"));
    await waitFor(() => expect(screen.getByTestId("paywall-sheet")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("paywall-pay"));
    // the fallback re-runs onRun with { pay: true }
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2));
    expect(onRun.mock.calls[1]![1]).toEqual({ pay: true });
    await waitFor(() =>
      expect(screen.getByTestId("playground-response").textContent).toContain("server pay"),
    );
  });
});

describe("selectSubmitPayment (fixture routes through the action; live is fail-loud)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("the fixture submitter POSTs the X-PAYMENT header back through the route action", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({ paid: true, debitAmount: "12000", body: { echo: "ok" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const submit = fixtureSubmitPayment("0xres");
    const idemKey = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const result = await submit("ENCODED_HEADER", idemKey);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/resources/0xres");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // the signed cap rides the X-PAYMENT header; the idemKey is carried explicitly
    expect(headers["X-PAYMENT"]).toBe("ENCODED_HEADER");
    expect(headers["X-IDEM-KEY"]).toBe(idemKey);
    // the bigint debit is re-read from the serialized string
    expect(result.debitAmount).toBe(12000n);
    expect(result.paid).toBe(true);
  });

  it("selectSubmitPayment defaults to the fixture path when mode is absent/non-live", () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // absent mode -> fixture (a function that, when called, hits fetch)
    const submit = selectSubmitPayment({ resourceId: "0xres", mode: undefined });
    expect(typeof submit).toBe("function");
  });

  it("the live submitter (260623-deq) performs the real x402 POST, never throwing for a wired endpoint", async () => {
    const fetchSpy = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const submit = liveSubmitPayment({
      resourceUrl: "https://x.resources.example",
      getRequestBody: () => ({ text: "hi" }),
    });
    const result = await submit("HEADER", ("0x" + "00".repeat(32)) as `0x${string}`);
    expect(result.paid).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("selectSubmitPayment(mode:'live') with NO resourceUrl is the fail-loud live submitter", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const submit = selectSubmitPayment({ resourceId: "0xres", mode: "live" });
    await expect(submit("HEADER", ("0x" + "00".repeat(32)) as `0x${string}`)).rejects.toThrow(
      /operator-gated/i,
    );
    await expect(submit("HEADER", ("0x" + "00".repeat(32)) as `0x${string}`)).rejects.toBeInstanceOf(
      RequiresLivePaymentError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
