// revenue-route suite (STU-04): GET /revenue/:resourceId aggregates the optional
// RevenueLedger's per-resource settlement rows into the studio RevenueSummary JSON.
//
// Fully offline + in-process: createApp over an InMemoryRevenueLedger, driven through
// app.request. No relayer / chain / network is exercised (the money-path deps are
// present only to satisfy AppDeps; this suite never hits /settle). All money crosses
// JSON as DECIMAL STRINGS and round-trips to bigint here; no decimals literal.
import { describe, it, expect } from "vitest";
import { type Hex, type PublicClient } from "viem";
import {
  InMemoryPaymentStore,
  InMemoryResultStore,
  InMemoryRevenueLedger,
  type SettlementEntry,
} from "@utter/x402-arc";
import { PAYMENT_ESCROW, PAYMENT_SPLITTER, USDC } from "@utter/chain";
import { createApp, type AppDeps } from "../src/app";
import { createInMemoryBuyerLock } from "../src/verify";
import type { RelayerPool } from "../src/relayer";

const RESOURCE_A: Hex = `0x${"a1".repeat(32)}`;
const RESOURCE_B: Hex = `0x${"b2".repeat(32)}`;
const UNKNOWN: Hex = `0x${"cc".repeat(32)}`;

/** A no-op relayer pool (this suite never settles). */
function noopRelayerPool(): RelayerPool {
  return {
    signers: [],
    pickSigner: () => {
      throw new Error("revenue-route test never settles");
    },
    reserveNonce: async () => 0,
    resyncNonce: async () => {},
    checkBalances: async () => [],
  } as unknown as RelayerPool;
}

/** A stub public client (unused by /revenue; present to satisfy AppDeps). */
function stubPublicClient(): PublicClient {
  return {} as unknown as PublicClient;
}

/** Build the app over a given ledger (or none). */
function makeApp(revenueLedger?: InMemoryRevenueLedger) {
  const deps: AppDeps = {
    store: new InMemoryPaymentStore(),
    resultStore: new InMemoryResultStore(),
    relayerPool: noopRelayerPool(),
    publicClient: stubPublicClient(),
    perBuyerLock: createInMemoryBuyerLock(),
    escrowAddress: PAYMENT_ESCROW,
    splitterAddress: PAYMENT_SPLITTER,
    usdcAddress: USDC,
    maxTimeoutSeconds: 30,
    settleBufferSeconds: 90,
    revenueLedger,
  };
  return createApp(deps);
}

/** A settle entry helper (amount === creatorShare + platformShare). */
function settleEntry(
  resourceId: Hex,
  idemKey: Hex,
  amount: bigint,
  creatorShare: bigint,
  tx: Hex,
): SettlementEntry {
  return {
    idemKey,
    resourceId,
    amount,
    creatorShare,
    platformShare: amount - creatorShare,
    tx,
    kind: "settle",
    at: Date.now(),
  };
}

describe("GET /revenue/:resourceId", () => {
  it("aggregates calls/gross/split/refunds + receipt rows; bigints round-trip as strings", async () => {
    const ledger = new InMemoryRevenueLedger();
    // Two settles + one refund for RESOURCE_A; a settle for RESOURCE_B must NOT bleed in.
    await ledger.record(
      settleEntry(RESOURCE_A, `0x${"01".repeat(32)}`, 20_000n, 14_000n, `0x${"11".repeat(32)}`),
    );
    await ledger.record(
      settleEntry(RESOURCE_A, `0x${"02".repeat(32)}`, 10_000n, 7_000n, `0x${"12".repeat(32)}`),
    );
    await ledger.record({
      idemKey: `0x${"03".repeat(32)}`,
      resourceId: RESOURCE_A,
      amount: 5_000n,
      creatorShare: 0n,
      platformShare: 0n,
      tx: `0x${"13".repeat(32)}`,
      kind: "refund",
      at: Date.now(),
    });
    await ledger.record(
      settleEntry(RESOURCE_B, `0x${"04".repeat(32)}`, 99_000n, 70_000n, `0x${"14".repeat(32)}`),
    );

    const app = makeApp(ledger);
    const res = await app.request(`/revenue/${RESOURCE_A}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resourceId: string;
      calls: number;
      gross: string;
      creatorShare: string;
      platformShare: string;
      refunds: string;
      receipts: Array<{ tx: string; kind: string; amount: string; idemKey: string }>;
    };

    expect(body.resourceId).toBe(RESOURCE_A);
    // Two settles counted; the refund is NOT a call.
    expect(body.calls).toBe(2);
    // gross = sum of settle amounts; serialized as a decimal STRING.
    expect(body.gross).toBe("30000");
    expect(BigInt(body.gross)).toBe(30_000n);
    // creator/platform are the summed legs; together they equal gross.
    expect(body.creatorShare).toBe("21000");
    expect(body.platformShare).toBe("9000");
    expect(BigInt(body.creatorShare) + BigInt(body.platformShare)).toBe(BigInt(body.gross));
    // refunds = sum of refund amounts.
    expect(body.refunds).toBe("5000");
    // Three receipt rows (2 settle + 1 refund), each amount a decimal string.
    expect(body.receipts).toHaveLength(3);
    const settles = body.receipts.filter((r) => r.kind === "settle");
    expect(settles).toHaveLength(3 - 1);
    expect(settles.map((r) => r.amount).sort()).toEqual(["10000", "20000"]);
    const refund = body.receipts.find((r) => r.kind === "refund");
    expect(refund?.amount).toBe("5000");
  });

  it("returns a valid ZERO summary (200) for an unknown resource, never an error", async () => {
    const app = makeApp(new InMemoryRevenueLedger());
    const res = await app.request(`/revenue/${UNKNOWN}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.calls).toBe(0);
    expect(body.gross).toBe("0");
    expect(body.creatorShare).toBe("0");
    expect(body.platformShare).toBe("0");
    expect(body.refunds).toBe("0");
    expect(body.receipts).toEqual([]);
  });

  it("returns a valid ZERO summary (200) when NO ledger is wired at all", async () => {
    const app = makeApp(undefined);
    const res = await app.request(`/revenue/${RESOURCE_A}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls: number; gross: string; receipts: unknown[] };
    expect(body.calls).toBe(0);
    expect(body.gross).toBe("0");
    expect(body.receipts).toEqual([]);
  });

  it("rejects a non-bytes32 resourceId with 400 (bad_resourceId)", async () => {
    const app = makeApp(new InMemoryRevenueLedger());
    // Too short / not 0x+64hex.
    const res = await app.request(`/revenue/0xabc`, { method: "GET" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe("bad_resourceId");
  });
});
