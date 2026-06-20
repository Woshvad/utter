// buildAccepts 402 body suite (PAY-01). Proves the escrow `accepts` entry
// advertises the custom utter-escrow scheme, the CAIP-2 network, the signed cap,
// the on-chain asset/escrow imported from @utter/chain, and the LOCKED EIP-712
// domain in `extra.eip712`; plus the optional standard-x402-v2 `exact` fallback
// entry (amount/payTo) a generic client can parse. Offline unit test - no env.
import { describe, it, expect } from "vitest";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import { buildAccepts } from "../src/accepts";

const resourceId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const payTo = "0x00000000000000000000000000000000000000aa" as const;

const pricing = {
  model: "metered",
  base: "5000",
  perKB: "100",
  computeMultiplier: "200",
} as const;

describe("accepts builder - escrow entry (PAY-01)", () => {
  it("advertises scheme, CAIP-2 network, signed cap, asset, escrow, and locked domain", () => {
    const body = buildAccepts({
      cap: 10_000n,
      pricing,
      resourceId,
      maxTimeoutSeconds: 30,
    });

    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);

    const entry = body.accepts[0]!;
    expect(entry.scheme).toBe("utter-escrow");
    expect(entry.network).toBe("eip155:5042002");
    expect(entry.maxAmountRequired).toBe("10000");
    expect(entry.asset).toBe(USDC);
    expect(entry.escrow).toBe(PAYMENT_ESCROW);
    expect(entry.payTo).toBe(resourceId);
    expect(entry.maxTimeoutSeconds).toBe(30);
    expect(entry.pricing).toEqual(pricing);

    expect(entry.extra && "eip712" in entry.extra, "escrow entry missing extra.eip712").toBe(
      true,
    );
    const extra = entry.extra as { eip712: unknown };
    expect(extra.eip712).toEqual({
      name: "UtterEscrow",
      version: "1",
      chainId: 5042002,
      verifyingContract: PAYMENT_ESCROW,
    });
  });

  it("serializes the cap from bigint to its base-unit string", () => {
    const body = buildAccepts({
      cap: 250_000n,
      pricing,
      resourceId,
      maxTimeoutSeconds: 10,
    });
    expect(body.accepts[0]!.maxAmountRequired).toBe("250000");
  });
});

describe("accepts builder - exact fallback entry (standard x402 v2)", () => {
  it("emits a standard-shaped exact entry (amount/payTo) for generic-client interop", () => {
    const body = buildAccepts({
      cap: 10_000n,
      pricing,
      resourceId,
      maxTimeoutSeconds: 30,
      exact: { amount: 8_000n, payTo },
    });

    expect(body.accepts).toHaveLength(2);
    const exact = body.accepts.find((e) => e.scheme === "exact");
    expect(exact, "exact entry missing").toBeDefined();
    // Standard x402 v2 field names so a generic client can parse it.
    expect(exact!.amount).toBe("8000");
    expect(exact!.payTo).toBe(payTo);
    expect(exact!.network).toBe("eip155:5042002");
    expect(exact!.asset).toBe(USDC);
    expect(exact!.extra).toEqual({ name: "USDC", version: "2" });
  });
});
