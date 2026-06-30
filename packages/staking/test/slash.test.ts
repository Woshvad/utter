// Slash driver tests (STK-02). The slash is COUPLED across the registry and the
// vault on chain: recordSlashAuthorization records a single-use PendingSlash with a
// 1-day dispute window, and StakingVault.slash (driven by executeMaturedSlash) only
// lands once the window elapses and the amount matches, because the vault calls
// registry.consumeSlashAuthorization first. The driver is therefore two steps:
//   1. recordSlashAuthorization: registry.slashAuthorization (starts the window).
//   2. executeMaturedSlash: reads getPendingSlash FIRST and only broadcasts the
//      vault slash when matured + matching; otherwise it does NOT broadcast.
import { describe, it, expect, vi } from "vitest";
import {
  STAKING_VAULT,
  RESOURCE_REGISTRY,
  stakingVaultAbi,
  registryAbi,
} from "@utter/chain";
import type { BondSlashReview } from "@utter/ai-scorer";
import { recordSlashAuthorization, executeMaturedSlash } from "../src/slash";

const RESOURCE = `0x${"cd".repeat(32)}` as `0x${string}`;

/** A BondSlashReview as the ai-scorer raises it on the 5th consecutive failure. */
function review(over: Partial<BondSlashReview> = {}): BondSlashReview {
  return {
    resourceId: RESOURCE,
    reason: "5 consecutive failing probes",
    consecutiveFailures: 5,
    deactivatedAtProbe: 42,
    ...over,
  };
}

/** A mock admin walletClient recording each writeContract call in order. */
function mockAdmin() {
  const calls: Array<{ address: string; functionName: string; args: unknown[] }> = [];
  const writeContract = vi.fn(async (args: {
    address: string;
    functionName: string;
    args: unknown[];
  }) => {
    calls.push({ address: args.address, functionName: args.functionName, args: args.args });
    return `0x${"11".repeat(32)}` as `0x${string}`;
  });
  return { client: { writeContract } as never, writeContract, calls };
}

/**
 * A mock publicClient that acks the receipt wait, answers the WR-04 pre-flight bond
 * read with `bond`, and answers getPendingSlash with the supplied pending tuple.
 */
function mockPublicClient(opts: {
  bond?: bigint;
  pending?: readonly [bigint, bigint];
} = {}) {
  const bond = opts.bond ?? 10_000_000n;
  const pending = opts.pending ?? ([0n, 0n] as const);
  const waitForTransactionReceipt = vi.fn(async (_a: unknown) => ({ status: "success" }));
  const readContract = vi.fn(async (a: { functionName: string }) => {
    if (a.functionName === "bonds") return bond;
    if (a.functionName === "getPendingSlash") return pending;
    throw new Error(`unexpected read: ${a.functionName}`);
  });
  return { client: { waitForTransactionReceipt, readContract } as never, readContract };
}

describe("recordSlashAuthorization (STK-02 step 1)", () => {
  const AMOUNT = 1_000_000n;

  it("records the registry slashAuthorization (no vault write)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    const result = await recordSlashAuthorization(
      { admin: admin.client, publicClient: pub.client },
      review(),
      AMOUNT,
    );

    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]).toMatchObject({
      address: RESOURCE_REGISTRY,
      functionName: "slashAuthorization",
    });
    expect(admin.calls[0]!.args).toEqual([RESOURCE, AMOUNT, "5 consecutive failing probes"]);
    expect(result.slashAuthorizationTx).toMatch(/^0x[0-9a-f]+$/);
  });

  it("encodes via registryAbi", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await recordSlashAuthorization({ admin: admin.client, publicClient: pub.client }, review(), AMOUNT);
    const arg = admin.writeContract.mock.calls[0]![0] as unknown as { abi: unknown };
    expect(arg.abi).toBe(registryAbi);
  });

  it("WR-04: refuses an over-bond authorization BEFORE any write", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient({ bond: 1_000_000n });
    await expect(
      recordSlashAuthorization({ admin: admin.client, publicClient: pub.client }, review(), 1_500_000n),
    ).rejects.toThrow(/exceeds current bond|would revert/i);
    expect(admin.writeContract).not.toHaveBeenCalled();
    expect(pub.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "bonds", args: [RESOURCE] }),
    );
  });

  it("allows an authorization with amount equal to the current bond", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient({ bond: AMOUNT });
    await recordSlashAuthorization({ admin: admin.client, publicClient: pub.client }, review(), AMOUNT);
    expect(admin.calls).toHaveLength(1);
  });

  it("refuses a non-positive amount before any write", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await expect(
      recordSlashAuthorization({ admin: admin.client, publicClient: pub.client }, review(), 0n),
    ).rejects.toThrow();
    expect(admin.writeContract).not.toHaveBeenCalled();
  });

  it("only fires from a STRIKE_LIMIT review (a sub-limit review is rejected)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await expect(
      recordSlashAuthorization(
        { admin: admin.client, publicClient: pub.client },
        review({ consecutiveFailures: 3 }),
        AMOUNT,
      ),
    ).rejects.toThrow();
    expect(admin.writeContract).not.toHaveBeenCalled();
  });
});

describe("executeMaturedSlash (STK-02 step 2)", () => {
  const AMOUNT = 1_000_000n;
  const EXECUTABLE_AT = 1_000_000n; // a unix-seconds maturity timestamp

  it("does NOT broadcast when the pending slash is not yet matured", async () => {
    const admin = mockAdmin();
    // Window still active: now is one second before executableAt.
    const pub = mockPublicClient({ pending: [AMOUNT, EXECUTABLE_AT] });
    const result = await executeMaturedSlash(
      { admin: admin.client, publicClient: pub.client },
      review(),
      AMOUNT,
      EXECUTABLE_AT - 1n,
    );

    expect(result).toMatchObject({ executed: false, reason: "not-yet-matured" });
    expect(admin.writeContract).not.toHaveBeenCalled();
    // It read getPendingSlash to make the decision, never the vault slash.
    expect(pub.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "getPendingSlash", args: [RESOURCE] }),
    );
  });

  it("broadcasts StakingVault.slash when the pending slash IS matured + matching", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient({ pending: [AMOUNT, EXECUTABLE_AT] });
    const result = await executeMaturedSlash(
      { admin: admin.client, publicClient: pub.client },
      review(),
      AMOUNT,
      EXECUTABLE_AT, // now == executableAt: matured (consume requires >=)
    );

    expect(result).toMatchObject({ executed: true });
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]).toMatchObject({ address: STAKING_VAULT, functionName: "slash" });
    expect(admin.calls[0]!.args).toEqual([RESOURCE, AMOUNT, "5 consecutive failing probes"]);
    const arg = admin.writeContract.mock.calls[0]![0] as unknown as { abi: unknown };
    expect(arg.abi).toBe(stakingVaultAbi);
  });

  it("does NOT broadcast when there is no pending authorization", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient({ pending: [0n, 0n] });
    const result = await executeMaturedSlash(
      { admin: admin.client, publicClient: pub.client },
      review(),
      AMOUNT,
      EXECUTABLE_AT,
    );
    expect(result).toMatchObject({ executed: false, reason: "no-pending-authorization" });
    expect(admin.writeContract).not.toHaveBeenCalled();
  });

  it("does NOT broadcast when the recorded amount does not match", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient({ pending: [AMOUNT, EXECUTABLE_AT] });
    const result = await executeMaturedSlash(
      { admin: admin.client, publicClient: pub.client },
      review(),
      AMOUNT + 1n, // caller-supplied amount differs from the recorded one
      EXECUTABLE_AT,
    );
    expect(result).toMatchObject({ executed: false, reason: "amount-mismatch", pendingAmount: AMOUNT });
    expect(admin.writeContract).not.toHaveBeenCalled();
  });

  it("requires a public client with a getPendingSlash read", async () => {
    const admin = mockAdmin();
    await expect(
      executeMaturedSlash({ admin: admin.client }, review(), AMOUNT, EXECUTABLE_AT),
    ).rejects.toThrow(/public client|readContract|required/i);
    expect(admin.writeContract).not.toHaveBeenCalled();
  });
});
