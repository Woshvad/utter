// Bond gate tests (STK-01). The gate reads StakingVault.bonds(resourceId) off the
// injected publicClient (mock-chain, no network) and refuses publication when the
// bond is below MIN_BOND_BASE_UNITS or below a configured category minimum. A
// posted bond at/above both floors resolves ok. All bonds are USDC base units
// (bigint); no 6/1e6 literal appears in the gate.
import { describe, it, expect, vi } from "vitest";
import { STAKING_VAULT, stakingVaultAbi } from "@utter/chain";
import { createBondGate, PublishRejected, MIN_BOND_BASE_UNITS } from "../src/gate";

const RESOURCE = "0x" + "ab".repeat(32);

/**
 * A mock publicClient whose readContract returns a fixed bond for bonds(resourceId).
 * The spy lets us assert the gate reads the deployed StakingVault via stakingVaultAbi
 * with the bonds getter and the resourceId arg.
 */
function mockPublicClient(bond: bigint) {
  const readContract = vi.fn(async (_args: unknown) => bond);
  return { readContract } as unknown as Parameters<typeof createBondGate>[0]["publicClient"] & {
    readContract: ReturnType<typeof vi.fn>;
  };
}

describe("createBondGate (STK-01)", () => {
  it("resolves ok for a bond at the floor", async () => {
    const publicClient = mockPublicClient(MIN_BOND_BASE_UNITS);
    const gate = createBondGate({ publicClient });
    await expect(gate.check(RESOURCE, "general")).resolves.toBeUndefined();
  });

  it("resolves ok for a bond above the floor", async () => {
    const publicClient = mockPublicClient(MIN_BOND_BASE_UNITS * 5n);
    const gate = createBondGate({ publicClient });
    await expect(gate.check(RESOURCE, "general")).resolves.toBeUndefined();
  });

  it("reads bonds(resourceId) on the deployed StakingVault via stakingVaultAbi", async () => {
    const publicClient = mockPublicClient(MIN_BOND_BASE_UNITS);
    const gate = createBondGate({ publicClient });
    await gate.check(RESOURCE, "general");
    expect(publicClient.readContract).toHaveBeenCalledWith({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "bonds",
      args: [RESOURCE],
    });
  });

  it("rejects a missing bond (zero) with bond_not_posted", async () => {
    const publicClient = mockPublicClient(0n);
    const gate = createBondGate({ publicClient });
    await expect(gate.check(RESOURCE, "general")).rejects.toBeInstanceOf(PublishRejected);
    await expect(gate.check(RESOURCE, "general")).rejects.toMatchObject({
      reason: "bond_not_posted",
    });
  });

  it("rejects a below-floor bond with bond_not_posted", async () => {
    const publicClient = mockPublicClient(MIN_BOND_BASE_UNITS - 1n);
    const gate = createBondGate({ publicClient });
    await expect(gate.check(RESOURCE, "general")).rejects.toMatchObject({
      reason: "bond_not_posted",
    });
  });

  it("rejects a bond below a configured category minimum with bond_below_category_min", async () => {
    // The bond clears the global floor but not the premium category's higher minimum.
    const publicClient = mockPublicClient(MIN_BOND_BASE_UNITS);
    const gate = createBondGate({
      publicClient,
      categoryMinBond: { premium: MIN_BOND_BASE_UNITS * 10n },
    });
    await expect(gate.check(RESOURCE, "premium")).rejects.toMatchObject({
      reason: "bond_below_category_min",
    });
  });

  it("defaults every category to MIN_BOND_BASE_UNITS (Open Q1)", async () => {
    // An unconfigured category falls back to the global floor: a floor bond passes.
    const publicClient = mockPublicClient(MIN_BOND_BASE_UNITS);
    const gate = createBondGate({ publicClient });
    await expect(gate.check(RESOURCE, "any-unconfigured-category")).resolves.toBeUndefined();
  });

  it("PublishRejected carries a typed reason code", () => {
    const err = new PublishRejected("bond_not_posted");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PublishRejected");
    expect(err.reason).toBe("bond_not_posted");
  });
});
