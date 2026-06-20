// Slash trigger tests (STK-02). triggerSlash consumes a BondSlashReview (from the
// ai-scorer 5-strike reducer) and drives TWO writes through the injected admin
// walletClient:
//   1. ResourceRegistry.slashAuthorization (ADVISORY indexer signal, Pitfall 7)
//   2. StakingVault.slash with the ADMIN-supplied amount (the REAL spend)
// LOAD-BEARING: the two contracts share NO on-chain state. The trigger must NOT read
// back / reconcile the registry authorization before slashing - the admin amount is
// authoritative. The spy asserts the call ORDER and that slash uses the admin amount.
import { describe, it, expect, vi } from "vitest";
import {
  STAKING_VAULT,
  RESOURCE_REGISTRY,
  stakingVaultAbi,
  registryAbi,
} from "@utter/chain";
import type { BondSlashReview } from "@utter/ai-scorer";
import { triggerSlash } from "../src/slash";

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

/** A mock publicClient that just acks the receipt wait (no on-chain reconcile). */
function mockPublicClient() {
  const waitForTransactionReceipt = vi.fn(async (_a: unknown) => ({ status: "success" }));
  const readContract = vi.fn(async () => {
    throw new Error("triggerSlash must NOT read the registry to reconcile the amount");
  });
  return { client: { waitForTransactionReceipt, readContract } as never, readContract };
}

describe("triggerSlash (STK-02)", () => {
  const AMOUNT = 1_000_000n; // base units, supplied by the admin/review

  it("emits slashAuthorization THEN slash (advisory before the real spend)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await triggerSlash({ admin: admin.client, publicClient: pub.client }, review(), AMOUNT);

    expect(admin.calls).toHaveLength(2);
    // Step 1: advisory indexer signal on the registry.
    expect(admin.calls[0]).toMatchObject({
      address: RESOURCE_REGISTRY,
      functionName: "slashAuthorization",
    });
    // Step 2: the real spend on the vault.
    expect(admin.calls[1]).toMatchObject({
      address: STAKING_VAULT,
      functionName: "slash",
    });
  });

  it("drives StakingVault.slash with the ADMIN amount (not a registry-read amount)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await triggerSlash({ admin: admin.client, publicClient: pub.client }, review(), AMOUNT);

    const slashCall = admin.calls[1]!;
    expect(slashCall.args).toEqual([RESOURCE, AMOUNT, "5 consecutive failing probes"]);
    // The advisory call carries the SAME admin amount (consistent values).
    expect(admin.calls[0]!.args).toEqual([RESOURCE, AMOUNT, "5 consecutive failing probes"]);
  });

  it("encodes via stakingVaultAbi / registryAbi", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await triggerSlash({ admin: admin.client, publicClient: pub.client }, review(), AMOUNT);

    const authArg = admin.writeContract.mock.calls[0]![0] as unknown as { abi: unknown };
    const slashArg = admin.writeContract.mock.calls[1]![0] as unknown as { abi: unknown };
    expect(authArg.abi).toBe(registryAbi);
    expect(slashArg.abi).toBe(stakingVaultAbi);
  });

  it("does NOT reconcile against any on-chain authorization between the two writes", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    // pub.readContract throws if called; triggerSlash must never read to reconcile.
    await triggerSlash({ admin: admin.client, publicClient: pub.client }, review(), AMOUNT);
    expect(pub.readContract).not.toHaveBeenCalled();
  });

  it("returns the two tx hashes for the indexer / operator audit", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    const result = await triggerSlash(
      { admin: admin.client, publicClient: pub.client },
      review(),
      AMOUNT,
    );
    expect(result.slashAuthorizationTx).toMatch(/^0x[0-9a-f]+$/);
    expect(result.slashTx).toMatch(/^0x[0-9a-f]+$/);
  });

  it("refuses a non-positive admin amount before any write (defends the real spend)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    await expect(
      triggerSlash({ admin: admin.client, publicClient: pub.client }, review(), 0n),
    ).rejects.toThrow();
    expect(admin.writeContract).not.toHaveBeenCalled();
  });

  it("only fires from a STRIKE_LIMIT review (a sub-limit review is rejected)", async () => {
    const admin = mockAdmin();
    const pub = mockPublicClient();
    // A review that did not reach the 5-strike limit must not drive a slash.
    await expect(
      triggerSlash(
        { admin: admin.client, publicClient: pub.client },
        review({ consecutiveFailures: 3 }),
        AMOUNT,
      ),
    ).rejects.toThrow();
    expect(admin.writeContract).not.toHaveBeenCalled();
  });
});
