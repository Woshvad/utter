// Insurance refund accounting tests (STK-03) + the honest-creator withdrawBond
// passthrough (PLAN-CHECK W-1).
//
// identifyAffectedBuyers selects the settled payments for a resource inside the
// failure window [first-of-5-consecutive-failing-probes, deactivation] and computes
// the refund per payer (settled_amount, USDC base units). The aggregate is bounded
// by the insurancePoolBalance read so over-refund is refused BEFORE any write
// (mirroring the on-chain OverRefund guard). executeRefund drives
// StakingVault.refund(payer, amount) per buyer through the injected admin client.
// withdrawBond drives requestWithdraw/withdraw for the honest creator after COOLDOWN.
import { describe, it, expect, vi } from "vitest";
import { STAKING_VAULT, stakingVaultAbi } from "@utter/chain";
import {
  identifyAffectedBuyers,
  executeRefund,
  withdrawBond,
  InMemoryRefundIdempotencyStore,
  type SettledPayment,
} from "../src/refund";

const RESOURCE = `0x${"ef".repeat(32)}` as `0x${string}`;
const OTHER_RESOURCE = `0x${"12".repeat(32)}` as `0x${string}`;
const BUYER_A = `0x${"a".repeat(40)}` as `0x${string}`;
const BUYER_B = `0x${"b".repeat(40)}` as `0x${string}`;

function payment(over: Partial<SettledPayment> = {}): SettledPayment {
  return {
    resourceId: RESOURCE,
    payer: BUYER_A,
    amount: 500_000n,
    settledAt: 100,
    status: "settled",
    ...over,
  };
}

/** A mock admin walletClient recording each refund/withdraw write. */
function mockAdmin() {
  const calls: Array<{ functionName: string; args: unknown[] }> = [];
  const writeContract = vi.fn(async (a: { functionName: string; args: unknown[] }) => {
    calls.push({ functionName: a.functionName, args: a.args });
    return `0x${"22".repeat(32)}` as `0x${string}`;
  });
  return { client: { writeContract } as never, writeContract, calls };
}

describe("identifyAffectedBuyers (STK-03)", () => {
  const window = { from: 50, to: 200 };

  it("selects settled payments for the resource inside the window", () => {
    const payments: SettledPayment[] = [
      payment({ payer: BUYER_A, amount: 300_000n, settledAt: 60 }),
      payment({ payer: BUYER_B, amount: 200_000n, settledAt: 150 }),
    ];
    const affected = identifyAffectedBuyers(payments, RESOURCE, window);
    expect(affected).toEqual([
      { payer: BUYER_A, amount: 300_000n },
      { payer: BUYER_B, amount: 200_000n },
    ]);
  });

  it("excludes payments for other resources", () => {
    const payments: SettledPayment[] = [
      payment({ payer: BUYER_A, settledAt: 100 }),
      payment({ resourceId: OTHER_RESOURCE, payer: BUYER_B, settledAt: 100 }),
    ];
    const affected = identifyAffectedBuyers(payments, RESOURCE, window);
    expect(affected.map((a) => a.payer)).toEqual([BUYER_A]);
  });

  it("excludes payments outside the window boundaries", () => {
    const payments: SettledPayment[] = [
      payment({ settledAt: 49 }), // before from
      payment({ settledAt: 50 }), // inclusive from
      payment({ settledAt: 200 }), // inclusive to
      payment({ settledAt: 201 }), // after to
    ];
    const affected = identifyAffectedBuyers(payments, RESOURCE, window);
    expect(affected).toHaveLength(2);
  });

  it("excludes non-settled payments", () => {
    const payments: SettledPayment[] = [
      payment({ status: "settled", settledAt: 100 }),
      payment({ status: "pending", payer: BUYER_B, settledAt: 100 }),
    ];
    const affected = identifyAffectedBuyers(payments, RESOURCE, window);
    expect(affected.map((a) => a.payer)).toEqual([BUYER_A]);
  });
});

describe("executeRefund (STK-03)", () => {
  const window = { from: 0, to: 1000 };

  /** A mock publicClient reading the insurance pool balance. */
  function mockPool(balance: bigint) {
    const readContract = vi.fn(async () => balance);
    return { client: { readContract } as never, readContract };
  }

  it("refunds each affected buyer via StakingVault.refund", async () => {
    const admin = mockAdmin();
    const pool = mockPool(10_000_000n);
    const payments: SettledPayment[] = [
      payment({ payer: BUYER_A, amount: 300_000n }),
      payment({ payer: BUYER_B, amount: 200_000n }),
    ];
    const result = await executeRefund(
      { admin: admin.client, publicClient: pool.client },
      payments,
      RESOURCE,
      window,
    );

    expect(admin.calls).toHaveLength(2);
    expect(admin.calls[0]).toEqual({ functionName: "refund", args: [BUYER_A, 300_000n] });
    expect(admin.calls[1]).toEqual({ functionName: "refund", args: [BUYER_B, 200_000n] });
    expect(result.refunded).toEqual([
      { payer: BUYER_A, amount: 300_000n },
      { payer: BUYER_B, amount: 200_000n },
    ]);
    expect(result.totalRefunded).toBe(500_000n);
  });

  it("reads insurancePoolBalance via stakingVaultAbi before writing", async () => {
    const admin = mockAdmin();
    const pool = mockPool(10_000_000n);
    await executeRefund(
      { admin: admin.client, publicClient: pool.client },
      [payment({ amount: 100_000n })],
      RESOURCE,
      window,
    );
    expect(pool.readContract).toHaveBeenCalledWith({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "insurancePoolBalance",
      args: [],
    });
  });

  it("refuses over-refund BEFORE any write when the aggregate exceeds the pool", async () => {
    const admin = mockAdmin();
    const pool = mockPool(400_000n); // pool smaller than the 500k aggregate
    const payments: SettledPayment[] = [
      payment({ payer: BUYER_A, amount: 300_000n }),
      payment({ payer: BUYER_B, amount: 200_000n }),
    ];
    await expect(
      executeRefund({ admin: admin.client, publicClient: pool.client }, payments, RESOURCE, window),
    ).rejects.toThrow(/over.?refund|pool/i);
    // No refund write happened - the bound is checked before any spend.
    expect(admin.writeContract).not.toHaveBeenCalled();
  });

  it("refunds when the aggregate exactly equals the pool balance", async () => {
    const admin = mockAdmin();
    const pool = mockPool(500_000n);
    const payments: SettledPayment[] = [
      payment({ payer: BUYER_A, amount: 300_000n }),
      payment({ payer: BUYER_B, amount: 200_000n }),
    ];
    const result = await executeRefund(
      { admin: admin.client, publicClient: pool.client },
      payments,
      RESOURCE,
      window,
    );
    expect(result.totalRefunded).toBe(500_000n);
    expect(admin.calls).toHaveLength(2);
  });

  it("is a no-op (no write) when there are no affected buyers", async () => {
    const admin = mockAdmin();
    const pool = mockPool(10_000_000n);
    const result = await executeRefund(
      { admin: admin.client, publicClient: pool.client },
      [payment({ resourceId: OTHER_RESOURCE })],
      RESOURCE,
      window,
    );
    expect(admin.writeContract).not.toHaveBeenCalled();
    expect(result.totalRefunded).toBe(0n);
  });

  describe("idempotency on a mid-batch revert + retry (WR-01)", () => {
    const BUYER_C = `0x${"c".repeat(40)}` as `0x${string}`;

    /**
     * An admin that reverts on the Nth refund write (1-based) once, then succeeds on
     * every subsequent call (mirrors a transient on-chain revert that clears on retry).
     */
    function flakyAdmin(revertOnCall: number) {
      const calls: Array<{ functionName: string; args: unknown[] }> = [];
      let n = 0;
      let reverted = false;
      const writeContract = vi.fn(async (a: { functionName: string; args: unknown[] }) => {
        n += 1;
        if (n === revertOnCall && !reverted) {
          reverted = true;
          throw new Error("on-chain revert (simulated): refund tx N reverted");
        }
        calls.push({ functionName: a.functionName, args: a.args });
        return `0x${"22".repeat(32)}` as `0x${string}`;
      });
      return { client: { writeContract } as never, writeContract, calls };
    }

    it("a batch that reverts on buyer 2 of 3, retried, pays buyer 1 exactly once and completes 2+3", async () => {
      const pool = mockPool(10_000_000n);
      const idempotencyStore = new InMemoryRefundIdempotencyStore();
      const payments: SettledPayment[] = [
        payment({ payer: BUYER_A, amount: 100_000n }),
        payment({ payer: BUYER_B, amount: 200_000n }),
        payment({ payer: BUYER_C, amount: 300_000n }),
      ];

      // First attempt: write for A succeeds (recorded), write for B reverts -> throw.
      const first = flakyAdmin(2);
      await expect(
        executeRefund(
          { admin: first.client, publicClient: pool.client, idempotencyStore },
          payments,
          RESOURCE,
          window,
        ),
      ).rejects.toThrow(/revert/i);
      // Only buyer A was paid (and recorded) before the revert on B.
      expect(first.calls).toEqual([{ functionName: "refund", args: [BUYER_A, 100_000n] }]);

      // Retry: the same window reproduces the same buyer list. Buyer A is SKIPPED
      // (already refunded); only B + C are paid this time.
      const second = mockAdmin();
      const result = await executeRefund(
        { admin: second.client, publicClient: pool.client, idempotencyStore },
        payments,
        RESOURCE,
        window,
      );
      expect(second.calls).toEqual([
        { functionName: "refund", args: [BUYER_B, 200_000n] },
        { functionName: "refund", args: [BUYER_C, 300_000n] },
      ]);
      expect(result.refunded).toEqual([
        { payer: BUYER_B, amount: 200_000n },
        { payer: BUYER_C, amount: 300_000n },
      ]);
      expect(result.skipped).toEqual([{ payer: BUYER_A, amount: 100_000n }]);

      // Buyer A was paid EXACTLY ONCE across both attempts (no double-pay).
      const aPayments =
        first.calls.filter((c) => (c.args as unknown[])[0] === BUYER_A).length +
        second.calls.filter((c) => (c.args as unknown[])[0] === BUYER_A).length;
      expect(aPayments).toBe(1);
    });

    it("a fully-completed batch retried is a total no-op (every buyer skipped)", async () => {
      const pool = mockPool(10_000_000n);
      const idempotencyStore = new InMemoryRefundIdempotencyStore();
      const payments: SettledPayment[] = [
        payment({ payer: BUYER_A, amount: 100_000n }),
        payment({ payer: BUYER_B, amount: 200_000n }),
      ];
      const first = mockAdmin();
      await executeRefund(
        { admin: first.client, publicClient: pool.client, idempotencyStore },
        payments,
        RESOURCE,
        window,
      );
      expect(first.calls).toHaveLength(2);

      const second = mockAdmin();
      const result = await executeRefund(
        { admin: second.client, publicClient: pool.client, idempotencyStore },
        payments,
        RESOURCE,
        window,
      );
      expect(second.writeContract).not.toHaveBeenCalled();
      expect(result.refunded).toHaveLength(0);
      expect(result.skipped).toHaveLength(2);
    });
  });
});

describe("withdrawBond passthrough (W-1)", () => {
  it("requests a withdraw via StakingVault.requestWithdraw", async () => {
    const admin = mockAdmin();
    const tx = await withdrawBond.request({ admin: admin.client }, RESOURCE);
    expect(admin.calls).toEqual([{ functionName: "requestWithdraw", args: [RESOURCE] }]);
    expect(tx).toMatch(/^0x[0-9a-f]+$/);
  });

  it("finalizes a withdraw via StakingVault.withdraw (after COOLDOWN)", async () => {
    const admin = mockAdmin();
    const tx = await withdrawBond.finalize({ admin: admin.client }, RESOURCE);
    expect(admin.calls).toEqual([{ functionName: "withdraw", args: [RESOURCE] }]);
    expect(tx).toMatch(/^0x[0-9a-f]+$/);
  });

  it("encodes both via stakingVaultAbi", async () => {
    const admin = mockAdmin();
    await withdrawBond.request({ admin: admin.client }, RESOURCE);
    await withdrawBond.finalize({ admin: admin.client }, RESOURCE);
    const reqAbi = (admin.writeContract.mock.calls[0]![0] as unknown as { abi: unknown }).abi;
    const finAbi = (admin.writeContract.mock.calls[1]![0] as unknown as { abi: unknown }).abi;
    expect(reqAbi).toBe(stakingVaultAbi);
    expect(finAbi).toBe(stakingVaultAbi);
  });
});
