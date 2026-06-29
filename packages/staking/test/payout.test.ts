// Treasury fee sweep tests (MAINNET section 5). sweepTreasuryPayout reads the treasury's
// accrued PaymentEscrow.balanceOf and, when it is at/above the threshold (and not zero),
// drives escrow.withdraw(balance) through the injected admin client (which MUST be the
// treasury wallet, since withdraw is msg.sender-scoped). The spy asserts that the read
// targets PAYMENT_ESCROW with the treasury address, that the withdraw uses the FULL
// accrued balance as its amount, and that no write happens on an empty / below-threshold
// balance. PULL-PAYMENT: the helper sweeps ONLY the passed treasury account; there is no
// push-to-creator path. The autonomous suite injects a mock (no live broadcast).
import { describe, it, expect, vi } from "vitest";
import { PAYMENT_ESCROW, escrowAbi } from "@utter/chain";
import { sweepTreasuryPayout } from "../src/payout";

const TREASURY = `0x${"7".repeat(40)}` as `0x${string}`;
const TX_HASH = `0x${"33".repeat(32)}` as `0x${string}`;

/** A mock admin walletClient (the treasury wallet) recording each withdraw write. */
function mockAdmin() {
  const calls: Array<{ address: string; functionName: string; args: unknown[] }> = [];
  const writeContract = vi.fn(async (a: {
    address: string;
    functionName: string;
    args: unknown[];
  }) => {
    calls.push({ address: a.address, functionName: a.functionName, args: a.args });
    return TX_HASH;
  });
  return { client: { writeContract } as never, writeContract, calls };
}

/**
 * A mock publicClient that answers balanceOf with `accrued` and records the
 * waitForTransactionReceipt calls. `withWait` toggles whether the optional receipt-wait
 * surface is present (the helper must tolerate its absence).
 */
function mockPublicClient(accrued: bigint, withWait = true) {
  const readContract = vi.fn(async (_a: { functionName: string; args: unknown[] }) => accrued);
  const waitForTransactionReceipt = vi.fn(async (_a: { hash: `0x${string}` }) => ({
    status: "success",
  }));
  const client = withWait ? { readContract, waitForTransactionReceipt } : { readContract };
  return { client: client as never, readContract, waitForTransactionReceipt };
}

describe("sweepTreasuryPayout (MAINNET section 5)", () => {
  it("is a no-op (no write) when the accrued balance is zero", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(0n);
    const result = await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY },
    );
    expect(admin.writeContract).not.toHaveBeenCalled();
    expect(result).toEqual({ accrued: 0n, withdrawn: 0n, tx: null });
  });

  it("does NOT write when the accrued balance is below the threshold", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(1_000_000n);
    const result = await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY, minThreshold: 5_000_000n },
    );
    expect(admin.writeContract).not.toHaveBeenCalled();
    expect(result).toEqual({ accrued: 1_000_000n, withdrawn: 0n, tx: null });
  });

  it("sweeps the FULL accrued balance via escrow.withdraw when above the threshold", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n);
    const result = await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY, minThreshold: 5_000_000n },
    );

    // EXACTLY ONE write: withdraw on PAYMENT_ESCROW with the full accrued balance.
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]).toMatchObject({
      address: PAYMENT_ESCROW,
      functionName: "withdraw",
      args: [9_000_000n],
    });
    expect(result).toEqual({ accrued: 9_000_000n, withdrawn: 9_000_000n, tx: TX_HASH });
  });

  it("sweeps with no threshold (defaults to 0n) when there is an accrued balance", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n);
    const result = await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY },
    );
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]).toMatchObject({ functionName: "withdraw", args: [9_000_000n] });
    expect(result.withdrawn).toBe(9_000_000n);
  });

  it("reads balanceOf against PAYMENT_ESCROW with the treasury address (and withdraw targets PAYMENT_ESCROW)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n);
    await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY },
    );
    expect(pub.readContract).toHaveBeenCalledWith({
      address: PAYMENT_ESCROW,
      abi: escrowAbi,
      functionName: "balanceOf",
      args: [TREASURY],
    });
    expect(admin.calls[0]!.address).toBe(PAYMENT_ESCROW);
  });

  it("awaits waitForTransactionReceipt with the returned tx when the client provides it", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n, true);
    const result = await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY },
    );
    expect(pub.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: result.tx });
  });

  it("tolerates a publicClient with no waitForTransactionReceipt", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n, false);
    const result = await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY },
    );
    expect(result).toEqual({ accrued: 9_000_000n, withdrawn: 9_000_000n, tx: TX_HASH });
  });

  it("encodes the withdraw via escrowAbi", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n);
    await sweepTreasuryPayout(
      { admin: admin.client, publicClient: pub.client },
      { treasury: TREASURY },
    );
    const arg = admin.writeContract.mock.calls[0]![0] as unknown as { abi: unknown };
    expect(arg.abi).toBe(escrowAbi);
  });

  it("throws on a negative minThreshold before any read or write", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient(9_000_000n);
    await expect(
      sweepTreasuryPayout(
        { admin: admin.client, publicClient: pub.client },
        { treasury: TREASURY, minThreshold: -1n },
      ),
    ).rejects.toThrow();
    expect(admin.writeContract).not.toHaveBeenCalled();
    expect(pub.readContract).not.toHaveBeenCalled();
  });
});
