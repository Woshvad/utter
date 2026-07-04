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
import {
  formatUnits,
  getAbiItem,
  isAddress,
  type Address,
  type PublicClient,
} from "viem";
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

/** One on-chain PaymentEscrow.Withdrawn record - a creator's money OUT. */
export interface WithdrawalRecord {
  /** The on-chain tx hash of the withdraw (for the ArcScan TxLink). */
  tx: Hex;
  /** The withdrawn amount in USDC base units (bigint). */
  amount: bigint;
  /** The block number the withdraw landed in (drives newest-first ordering). */
  blockNumber: bigint;
}

/** An account's withdrawal history: the records (newest-first) + runtime decimals. */
export interface WithdrawalHistory {
  /** Withdrawal records, newest-first. */
  records: WithdrawalRecord[];
  /** Decimals read from USDC at runtime (never a literal). */
  decimals: number;
}

/** One on-chain PaymentEscrow.Deposited record - an account's money IN (the inflow
 * counterpart to WithdrawalRecord; identical shape). */
export interface DepositRecord {
  /** The on-chain tx hash of the deposit (for the ArcScan TxLink). */
  tx: Hex;
  /** The deposited amount in USDC base units (bigint). */
  amount: bigint;
  /** The block number the deposit landed in (drives newest-first ordering). */
  blockNumber: bigint;
}

/** An account's deposit history: the records (newest-first) + runtime decimals. */
export interface DepositHistory {
  /** Deposit records, newest-first. */
  records: DepositRecord[];
  /** Decimals read from USDC at runtime (never a literal). */
  decimals: number;
}

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
 * Read an account's PaymentEscrow.Withdrawn events - the outflows that
 * `escrow.withdraw` emitted - formatted with USDC's runtime decimals. The `account`
 * is the indexed topic, so the getLogs filter is exact. The full account history is
 * scanned by default (fromBlock 0n, no silent window cap); fromBlock is pinnable for
 * RPCs that limit the block range. This is a pure read - it mirrors readEscrowBalance
 * (the local Hex alias, the isAddress guard, the runtime decimals discipline) and
 * never touches a write path.
 *
 * @throws if `account` is not a valid EVM address (ASVS V5 input validation).
 */
export async function readWithdrawals(
  client: PublicClient,
  account: Address,
  opts?: { escrowAddress?: Address; fromBlock?: bigint },
): Promise<WithdrawalHistory> {
  if (!isAddress(account)) {
    throw new Error(`readWithdrawals: invalid account address: ${account}`);
  }

  const escrowAddress = opts?.escrowAddress ?? PAYMENT_ESCROW;
  // Full history by default - the documented no-silent-cap choice. fromBlock is
  // pinnable for RPCs that limit the scan range.
  const fromBlock = opts?.fromBlock ?? 0n;

  // Resolve the Withdrawn event item from escrowAbi so the fragment stays single-
  // sourced (the same ABI the facilitator decodes against), never re-typed here.
  const withdrawnEvent = getAbiItem({ abi: escrowAbi, name: "Withdrawn" });

  // Read USDC decimals() and the account's Withdrawn logs together. `decimals` comes
  // from chain, never a literal - the CHAIN-03 enforcement point. The logs are
  // filtered by the indexed `account` topic (viem's house filter) against the escrow.
  const [decimals, logs] = await Promise.all([
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    client.getLogs({
      address: escrowAddress,
      event: withdrawnEvent,
      args: { account },
      fromBlock,
      toBlock: "latest",
      // strict: only return logs that fully decode against the Withdrawn event, so a
      // surviving log always carries a decoded `amount` (defense in depth for a money
      // read - a malformed/partial log is dropped rather than read as a zero amount).
      strict: true,
    }),
  ]);

  // Drop pending logs (no blockNumber / txHash yet), map to records, sort newest-first.
  // `amount` is required (strict getLogs); tx/blockNumber are nullable only for pending
  // logs, already excluded by the filter above.
  const records: WithdrawalRecord[] = logs
    .filter((l) => l.blockNumber != null && l.transactionHash != null)
    .map((l) => ({
      tx: l.transactionHash as Hex,
      amount: l.args.amount,
      blockNumber: l.blockNumber as bigint,
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0));

  return { records, decimals };
}

/**
 * Read an account's PaymentEscrow.Deposited events - the inflows that
 * `escrow.deposit` emitted - formatted with USDC's runtime decimals. This is the
 * money-IN mirror of readWithdrawals: the same indexed-`account` getLogs filter, the
 * same full-history-by-default scan (fromBlock 0n, pinnable), the same strict decode
 * and newest-first ordering, and the same runtime decimals discipline. A pure read;
 * it never touches a write path.
 *
 * @throws if `account` is not a valid EVM address (ASVS V5 input validation).
 */
export async function readDeposits(
  client: PublicClient,
  account: Address,
  opts?: { escrowAddress?: Address; fromBlock?: bigint },
): Promise<DepositHistory> {
  if (!isAddress(account)) {
    throw new Error(`readDeposits: invalid account address: ${account}`);
  }

  const escrowAddress = opts?.escrowAddress ?? PAYMENT_ESCROW;
  const fromBlock = opts?.fromBlock ?? 0n;

  // Resolve the Deposited event item from escrowAbi so the fragment stays single-
  // sourced (the same ABI the money path decodes against), never re-typed here.
  const depositedEvent = getAbiItem({ abi: escrowAbi, name: "Deposited" });

  // Read USDC decimals() and the account's Deposited logs together. `decimals` comes
  // from chain, never a literal - the CHAIN-03 enforcement point. The logs are filtered
  // by the indexed `account` topic against the escrow.
  const [decimals, logs] = await Promise.all([
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    client.getLogs({
      address: escrowAddress,
      event: depositedEvent,
      args: { account },
      fromBlock,
      toBlock: "latest",
      // strict: only fully-decoding logs survive, so a record always carries a decoded
      // `amount` (defense in depth for a money read - a partial log is dropped, not zeroed).
      strict: true,
    }),
  ]);

  // Drop pending logs (no blockNumber / txHash yet), map to records, sort newest-first.
  const records: DepositRecord[] = logs
    .filter((l) => l.blockNumber != null && l.transactionHash != null)
    .map((l) => ({
      tx: l.transactionHash as Hex,
      amount: l.args.amount,
      blockNumber: l.blockNumber as bigint,
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0));

  return { records, decimals };
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
