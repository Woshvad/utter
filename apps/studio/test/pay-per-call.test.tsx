// pay-per-call.test.tsx - PAYMENT-CRITICAL tests for usePayPerCall (260622-wlu).
//
// usePayPerCall is the consumption half of the product: at the 402 PaywallSheet the
// CONNECTED WALLET signs an x402 escrow DebitAuthorization (a CAP only) - no private key
// in the app - and the signed payment is encoded into an X-PAYMENT header and submitted
// through an injectable seam. The facilitator (server-side) still enforces
// reserve-before-run + settle min(computed, cap) + exactly-once; the browser only signs
// + submits the cap.
//
// These tests are the RED gate. They mock wagmi (useAccount + useWalletClient) exactly
// like wallet.test.tsx: useAccount returns the connected address, useWalletClient returns
// a fake viem WalletClient whose signTypedData is a SPY returning a fixed 0x signature. A
// submit SPY is injected so NO network is touched. They assert every security invariant:
//   T-WLU-01 (no key/sig leak), T-WLU-02 (REUSED EIP-712, decode round-trip),
//   T-WLU-04 (exactly-once: retry never re-signs), T-WLU-05 (cap=0 rejected before sign,
//   no money/chain literal in source).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, waitFor, act } from "@testing-library/react";
import * as React from "react";
import { decodePayment, type AcceptsEntry } from "@utter/x402-arc";

const HERE = dirname(fileURLToPath(import.meta.url));

// The connected buyer address and the fixed signature the mocked wallet returns.
const BUYER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const FIXED_SIGNATURE =
  ("0x" + "ab".repeat(65)) as `0x${string}`; // a 65-byte signature stand-in

// The 32-byte (bytes32) resourceId the escrow `payTo` carries.
const RESOURCE_ID =
  "0x00000000000000000000000000000000000000000000000000000000000000a1" as `0x${string}`;

// --- wagmi mock: deterministic account + wallet client for the hook -----------
// signTypedData is the spy we assert against (domain/primaryType + call count). It
// returns the fixed signature so the hook never needs a real signer.
const signTypedDataSpy = vi.fn(async (_args: unknown): Promise<`0x${string}`> => FIXED_SIGNATURE);

let walletClientData: unknown = {
  account: { address: BUYER },
  signTypedData: signTypedDataSpy,
};
let accountState: { address?: string } = { address: BUYER };

vi.mock("wagmi", () => ({
  useAccount: () => accountState,
  useWalletClient: () => ({ data: walletClientData }),
}));

/** The submit seam signature - typed so the spy's mock.calls are [header, idemKey]. */
type SubmitSpy = (header: string, idemKey: `0x${string}`) => Promise<unknown>;

/** Build a typed submit spy (so mock.calls carries the [string, Hex] tuple, not []). */
function makeSubmitSpy(impl: SubmitSpy = async () => ({ ok: true })) {
  return vi.fn<SubmitSpy>(impl);
}

/** A minimal escrow accepts quote (the 402 entry) the hook reads cap/payTo/timeout from. */
function makeQuote(overrides: Partial<AcceptsEntry> = {}): AcceptsEntry {
  return {
    scheme: "utter-escrow",
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    escrow: "0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154",
    maxAmountRequired: "50000",
    payTo: RESOURCE_ID,
    maxTimeoutSeconds: 30,
    ...overrides,
  };
}

/**
 * Mount the hook in a probe component and return a handle exposing the latest hook
 * snapshot. Tests drive pay()/retry() through the returned ref.
 */
async function mountHook(opts: {
  decimals?: number;
  submitPayment: (header: string, idemKey: `0x${string}`) => Promise<unknown>;
}): Promise<{
  current: () => import("../app/wallet/usePayPerCall").UsePayPerCallResult;
}> {
  const { usePayPerCall } = await import("../app/wallet/usePayPerCall");
  const ref: { value?: import("../app/wallet/usePayPerCall").UsePayPerCallResult } = {};

  function Probe(): React.ReactElement {
    ref.value = usePayPerCall({ decimals: opts.decimals ?? 6, submitPayment: opts.submitPayment });
    return React.createElement("div");
  }
  render(React.createElement(Probe));
  await waitFor(() => expect(ref.value).toBeTruthy());
  return { current: () => ref.value! };
}

beforeEach(() => {
  signTypedDataSpy.mockClear();
  signTypedDataSpy.mockResolvedValue(FIXED_SIGNATURE);
  accountState = { address: BUYER };
  walletClientData = { account: { address: BUYER }, signTypedData: signTypedDataSpy };
});

describe("usePayPerCall - DebitAuthorization construction (cap from quote + runtime decimals)", () => {
  it("builds the message with buyer/resourceId/cap, a 32-byte nonce, and a future validBefore", async () => {
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });

    const nowSec = Math.floor(Date.now() / 1000);
    await act(async () => {
      await hook.current().pay(makeQuote());
    });

    // The signTypedData spy fired with the message the hook built.
    expect(signTypedDataSpy).toHaveBeenCalledTimes(1);
    const arg = signTypedDataSpy.mock.calls[0]![0] as {
      message: { buyer: string; resourceId: string; maxAmount: bigint; nonce: string; validBefore: bigint };
    };
    expect(arg.message.buyer).toBe(BUYER);
    expect(arg.message.resourceId).toBe(RESOURCE_ID);
    expect(arg.message.maxAmount).toBe(50000n);
    // a 32-byte (0x + 64 hex) single-use nonce
    expect(arg.message.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // validBefore is a FUTURE bigint (now + timeout + buffer), not a literal scale
    expect(typeof arg.message.validBefore).toBe("bigint");
    expect(arg.message.validBefore).toBeGreaterThan(BigInt(nowSec));
  });
});

describe("usePayPerCall - signing reuse (the FROZEN UtterEscrow/1 domain + primaryType)", () => {
  it("signs under ESCROW_DOMAIN name 'UtterEscrow'/version '1' with the DebitAuthorization primaryType", async () => {
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });

    await act(async () => {
      await hook.current().pay(makeQuote());
    });

    const arg = signTypedDataSpy.mock.calls[0]![0] as {
      domain: { name: string; version: string };
      primaryType: string;
      types: Record<string, unknown>;
    };
    expect(arg.domain.name).toBe("UtterEscrow");
    expect(arg.domain.version).toBe("1");
    expect(arg.primaryType).toBe("DebitAuthorization");
    // the locked types array is carried by the REUSED signer, not re-declared by the hook
    expect(arg.types.DebitAuthorization).toBeTruthy();
  });

  it("does NOT hand-roll its own EIP-712 types array or domain object in source", async () => {
    const src = readFileSync(resolve(HERE, "../app/wallet/usePayPerCall.ts"), "utf8");
    // the hook must REUSE signDebitAuthorization, never re-declare the typed-data shape
    expect(src).toContain("signDebitAuthorization");
    expect(src).toContain("encodePayment");
    // no hand-rolled DebitAuthorization types array / UtterEscrow domain literal here
    expect(src).not.toContain("UtterEscrow");
    expect(src).not.toMatch(/primaryType\s*:/);
    expect(src).not.toMatch(/verifyingContract\s*:/);
  });
});

describe("usePayPerCall - encodePayment + submit (X-PAYMENT round-trips)", () => {
  it("submits once with an X-PAYMENT header that decodePayment round-trips correctly", async () => {
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });

    let idemKey: `0x${string}` | undefined;
    await act(async () => {
      const res = await hook.current().pay(makeQuote());
      idemKey = res.idemKey;
    });

    expect(submitPayment).toHaveBeenCalledTimes(1);
    const [header, submittedIdemKey] = submitPayment.mock.calls[0]! as [string, `0x${string}`];
    expect(submittedIdemKey).toBe(idemKey);

    const decoded = decodePayment(header);
    expect(decoded.scheme).toBe("utter-escrow");
    expect(decoded.network).toBe("eip155:5042002");
    expect(decoded.x402Version).toBe(2);
    expect(decoded.authorization.buyer).toBe(BUYER);
    expect(decoded.authorization.maxAmount).toBe("50000");
    expect(decoded.authorization.resourceId).toBe(RESOURCE_ID);
    expect(decoded.authorization.nonce).toBe(idemKey);
    expect(decoded.signature).toBe(FIXED_SIGNATURE);
  });
});

describe("usePayPerCall - exactly-once / never re-sign (T-WLU-04)", () => {
  it("retry(idemKey) re-submits the SAME header and never calls signTypedData again", async () => {
    const submitPayment = makeSubmitSpy(async () => ({ ok: true, attempt: submitPayment.mock.calls.length }));
    const hook = await mountHook({ submitPayment });

    let idemKey: `0x${string}` | undefined;
    let firstHeader: string | undefined;
    await act(async () => {
      const res = await hook.current().pay(makeQuote());
      idemKey = res.idemKey;
    });
    firstHeader = submitPayment.mock.calls[0]![0] as string;
    expect(signTypedDataSpy).toHaveBeenCalledTimes(1);

    // retry with the SAME idemKey: re-submit the recorded payload, NEVER a re-sign.
    await act(async () => {
      await hook.current().retry(idemKey!);
    });
    // exactly-once: still ONE signature; the same header re-submitted.
    expect(signTypedDataSpy).toHaveBeenCalledTimes(1);
    expect(submitPayment).toHaveBeenCalledTimes(2);
    const retryHeader = submitPayment.mock.calls[1]![0] as string;
    expect(retryHeader).toBe(firstHeader);
    expect((submitPayment.mock.calls[1]![1] as string)).toBe(idemKey);
  });

  it("retry on an unknown idemKey throws (nothing recorded to re-submit) - never a fresh sign", async () => {
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });
    await expect(
      hook.current().retry(("0x" + "11".repeat(32)) as `0x${string}`),
    ).rejects.toThrow();
    expect(signTypedDataSpy).not.toHaveBeenCalled();
  });
});

describe("usePayPerCall - cap=0 rejected before any signature (T-WLU-05)", () => {
  it("throws on a 0 cap BEFORE signTypedData is ever called", async () => {
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });
    await expect(hook.current().pay(makeQuote({ maxAmountRequired: "0" }))).rejects.toThrow();
    expect(signTypedDataSpy).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("throws on an absent/non-positive cap BEFORE signing", async () => {
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });
    await expect(
      hook.current().pay(makeQuote({ maxAmountRequired: undefined, amount: undefined })),
    ).rejects.toThrow();
    expect(signTypedDataSpy).not.toHaveBeenCalled();
  });
});

describe("usePayPerCall - no signature / buyer leak (T-WLU-01)", () => {
  it("never logs the signature or the buyer address across the whole pay() call", async () => {
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });

    await act(async () => {
      await hook.current().pay(makeQuote());
    });

    // assert the fixed signature + buyer address never appear in any logged argument
    for (const spy of logSpies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        expect(joined).not.toContain(FIXED_SIGNATURE);
        expect(joined).not.toContain(BUYER);
      }
    }
    for (const spy of logSpies) spy.mockRestore();
  });
});

describe("usePayPerCall - no money/chain literal in source (T-WLU-05 source-grep)", () => {
  it("carries no 5042002 / 1e6 / 10**6 / decimals money-or-chain literal", () => {
    const src = readFileSync(resolve(HERE, "../app/wallet/usePayPerCall.ts"), "utf8");
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const forbidden = [
      /5042002/,
      /1e6/i,
      /10\s*\*\*\s*6/,
      /\/\s*1000000/,
      /\b6n\b/,
      /\b18n\b/,
      /BigInt\(\s*6\s*\)/,
      /BigInt\(\s*18\s*\)/,
    ];
    for (const re of forbidden) {
      expect(stripped, `usePayPerCall.ts should carry no literal (${re})`).not.toMatch(re);
    }
  });
});

describe("usePayPerCall - guard rails", () => {
  it("errors (no sign) when the wallet client is not connected", async () => {
    walletClientData = undefined;
    accountState = {};
    const submitPayment = makeSubmitSpy();
    const hook = await mountHook({ submitPayment });
    await expect(hook.current().pay(makeQuote())).rejects.toThrow();
    expect(signTypedDataSpy).not.toHaveBeenCalled();
  });
});
