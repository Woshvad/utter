// readEscrowBalance + readBondStatus - the payout-surface chain READS (CHAIN-03).
//
// readUsdcBalance reads the wallet's USDC token balance. The payout surface needs
// two things it does NOT cover: the creator's ACCRUED internal escrow balance
// (PaymentEscrow.balanceOf[account], what `escrow.withdraw` pays out) and a
// resource's bond status (amount, owner, cooldown) from the StakingVault. Both are
// pure reads; the writes (escrow.withdraw, stakingVault.requestWithdraw/withdraw)
// already exist in the ABIs and the studio.
//
// The decimals trap (SPEC §6): USDC at 0x3600…0000 is simultaneously the 18-dp
// native gas token and the 6-dp ERC-20. Every amount formatted here reads
// `decimals()` from USDC at call time via viem `formatUnits` - exactly like
// readUsdcBalance. There is intentionally no numeric decimals literal below.
import { formatUnits, isAddress, type Address, type PublicClient } from "viem";
import { erc20Abi, escrowAbi, stakingVaultAbi } from "./abis";
import { USDC, PAYMENT_ESCROW, STAKING_VAULT } from "./addresses";
import { type UsdcBalance } from "./usdc";

// Local 0x-prefixed hex alias. The package does not export a Hex type from its
// index, so the bytes32 resourceId is typed locally here.
type Hex = `0x${string}`;

/**
 * The accrued escrow balance reuses the USDC balance shape: a raw base-unit
 * bigint, the runtime decimals, and the formatted string. Alias so callers can
 * name the escrow balance distinctly while the structure stays identical.
 */
export type EscrowBalance = UsdcBalance;

/** A resource's bond status as read from the StakingVault, amounts in base units. */
export interface BondStatus {
  /** The posted bond amount in USDC base units (bigint), from `bonds(resourceId)`. */
  amount: bigint;
  /** The address that posted the bond, from `bondOwner(resourceId)`. */
  owner: Address;
  /** Unix timestamp after which a requested withdraw may complete, from `cooldownEnds`. */
  cooldownEnds: bigint;
  /** Decimals read from USDC at runtime (expected 6) - never a literal. */
  decimals: number;
}

/**
 * Read an account's ACCRUED internal escrow balance - the amount it can pull out
 * via `escrow.withdraw` - applying USDC's runtime `decimals()` to format it.
 *
 * The balance is read against PAYMENT_ESCROW (PaymentEscrow.balanceOf), NOT the
 * wallet's USDC token balance. The decimals read still targets USDC, since the
 * escrow denominates the internal balance in USDC base units.
 *
 * @throws if `account` is not a valid EVM address (ASVS V5 input validation).
 */
export async function readEscrowBalance(
  client: PublicClient,
  account: Address,
  escrowAddress: Address = PAYMENT_ESCROW,
): Promise<UsdcBalance> {
  if (!isAddress(account)) {
    throw new Error(`readEscrowBalance: invalid account address: ${account}`);
  }

  // Read USDC decimals() and the escrow's balanceOf(account) together. `decimals`
  // comes from chain, never a literal - the CHAIN-03 enforcement point. The
  // balance read targets the escrow contract, not the USDC token.
  const [decimals, raw] = await Promise.all([
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    client.readContract({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "balanceOf",
      args: [account],
    }),
  ]);

  return {
    raw,
    decimals,
    formatted: formatUnits(raw, decimals),
  };
}

/**
 * Read a resource's bond status from the StakingVault: the posted amount, the
 * bond owner, and the cooldown-end timestamp, plus USDC's runtime decimals for
 * formatting the amount. This is a pure chain read.
 *
 * The caller (the studio) derives canWithdraw and is-owner from this: those need
 * `block.timestamp` and the connected creator address, which are UI concerns this
 * helper deliberately leaves out.
 *
 * @throws if `resourceId` is not a 32-byte (bytes32) hex value.
 */
export async function readBondStatus(
  client: PublicClient,
  resourceId: Hex,
  vaultAddress: Address = STAKING_VAULT,
): Promise<BondStatus> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(resourceId)) {
    throw new Error(`readBondStatus: invalid bytes32 resourceId: ${resourceId}`);
  }

  // Read the three vault mappings and USDC decimals() together. `decimals` comes
  // from chain, never a literal - the CHAIN-03 enforcement point for the bond
  // amount. The vault reads target STAKING_VAULT; decimals targets USDC.
  const [amount, owner, cooldownEnds, decimals] = await Promise.all([
    client.readContract({
      address: vaultAddress,
      abi: stakingVaultAbi,
      functionName: "bonds",
      args: [resourceId],
    }),
    client.readContract({
      address: vaultAddress,
      abi: stakingVaultAbi,
      functionName: "bondOwner",
      args: [resourceId],
    }),
    client.readContract({
      address: vaultAddress,
      abi: stakingVaultAbi,
      functionName: "cooldownEnds",
      args: [resourceId],
    }),
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  return { amount, owner, cooldownEnds, decimals };
}
