// gate.ts - the bond gate (STK-01). A resource may not publish unless it holds a
// posted bond at or above the on-chain floor (StakingVault.MIN_BOND_BASE_UNITS)
// AND any configured per-category minimum. The gate reads bonds(resourceId) off an
// INJECTED publicClient (the Phase 2 mock-chain pattern: services/facilitator/src/
// relayer.ts:178-183), so the autonomous suite proves the rejection logic against a
// mocked read with no live chain.
//
// DECIMALS DISCIPLINE (Pitfall 3): bonds are USDC base units (bigint). The floor is
// the on-chain constant StakingVault.MIN_BOND_BASE_UNITS (= 1_000_000 base units,
// $1 at 6 decimals). It is mirrored here as a BIGINT literal that mirrors the
// contract constant - it is NOT a 1e6/10**6 decimals-scaling literal in an
// amount-math path (no human amount is scaled by it; it is a comparison floor in the
// vault's native base-unit space). All comparisons stay in base units.
import { STAKING_VAULT, stakingVaultAbi } from "@utter/chain";

/**
 * The on-chain bond floor in USDC base units, mirrored from
 * `StakingVault.MIN_BOND_BASE_UNITS` (contracts/src/StakingVault.sol:79). The vault
 * denominates bonds in raw base units; this is the floor a resource's bond must meet
 * to publish. Base units only - never a decimals scaling literal.
 */
export const MIN_BOND_BASE_UNITS = 1_000_000n;

/** The typed reasons the gate refuses publication. */
export type PublishRejectedReason = "bond_not_posted" | "bond_below_category_min";

/**
 * Publication was refused because the resource's bond does not satisfy the gate.
 * `reason` is a stable machine code the publish pipeline surfaces to the creator.
 */
export class PublishRejected extends Error {
  readonly reason: PublishRejectedReason;
  constructor(reason: PublishRejectedReason) {
    super(`publish rejected: ${reason}`);
    this.name = "PublishRejected";
    this.reason = reason;
  }
}

/**
 * The minimal `publicClient.readContract` surface the gate needs. Matches viem's
 * `PublicClient` shape so the real Arc public client satisfies it, while a test mock
 * injects a spy (the gate never touches the live chain on its own).
 */
export interface BondReader {
  readContract(args: {
    address: `0x${string}`;
    abi: typeof stakingVaultAbi;
    functionName: "bonds";
    args: readonly [`0x${string}`];
  }): Promise<bigint>;
}

/** Options for {@link createBondGate}. */
export interface BondGateOpts {
  /** Injected read-path client (real Arc public client in prod; a spy in tests). */
  publicClient: BondReader;
  /**
   * Per-category minimum bond in USDC base units. Any category NOT present here
   * defaults to {@link MIN_BOND_BASE_UNITS} (Open Q1: no extra minimum). A category
   * configured ABOVE the floor raises the bar for that category only.
   */
  categoryMinBond?: Record<string, bigint>;
}

/** The bond gate: a single `check` that resolves on pass or throws {@link PublishRejected}. */
export interface BondGate {
  /**
   * Read the on-chain bond for `resourceId` and reject publication if it is below the
   * global floor or the category minimum. Resolves (void) when the bond satisfies
   * both. `category` selects the per-category minimum (defaults to the floor).
   */
  check(resourceId: `0x${string}`, category: string): Promise<void>;
}

/**
 * Build a bond gate over the deployed StakingVault. `check` reads bonds(resourceId)
 * via the injected client and throws {@link PublishRejected} when the bond is below
 * the global floor (`bond_not_posted`) or below the configured category minimum
 * (`bond_below_category_min`). No live chain access is performed by the gate itself.
 */
export function createBondGate(opts: BondGateOpts): BondGate {
  const { publicClient } = opts;
  const categoryMinBond = opts.categoryMinBond ?? {};

  return {
    async check(resourceId, category) {
      const bond = await publicClient.readContract({
        address: STAKING_VAULT,
        abi: stakingVaultAbi,
        functionName: "bonds",
        args: [resourceId],
      });

      // Global floor first: a missing or below-floor bond never publishes.
      if (bond < MIN_BOND_BASE_UNITS) {
        throw new PublishRejected("bond_not_posted");
      }

      // Category minimum: defaults to the global floor (Open Q1), so an unconfigured
      // category is already satisfied by the floor check above. A category configured
      // above the floor enforces its higher bar.
      const categoryMin = categoryMinBond[category] ?? MIN_BOND_BASE_UNITS;
      if (bond < categoryMin) {
        throw new PublishRejected("bond_below_category_min");
      }
    },
  };
}
