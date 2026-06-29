// payout.ts - the operator-gated TREASURY fee sweep (MAINNET.md section 5). It sweeps
// the platform TREASURY's accrued PaymentEscrow.balanceOf (the 30 percent cut credited
// by each settle's inline split) to the treasury wallet via escrow.withdraw.
//
// PULL-PAYMENT (LOAD-BEARING): PaymentEscrow.withdraw(amount) debits balanceOf[msg.sender]
// and sends to msg.sender (contracts/src/PaymentEscrow.sol:148-153). There is NO push
// primitive. So the injected AdminWriter MUST be built from the TREASURY key - the
// treasury withdraws its OWN balance to itself. The operator can ONLY sweep an account
// whose key it holds; CREATORS self-withdraw their own accrued share via the studio
// (the shipped pull flow). The operator cannot push funds to a creator, and this helper
// neither does nor implies any such path.
//
// DECIMALS DISCIPLINE (Pitfall 3): amounts are USDC base-unit bigint; the withdraw
// amount IS the read on-chain balance. No 6/1e6/decimals literal appears here
// (readEscrowBalance handles decimals for the script's human display only).
//
// Operator-gated: this module never reads a key; the caller builds the AdminWriter from
// a key in .env.local, and the autonomous suite injects a mock AdminWriter (no live
// broadcast). A concurrent double-sweep is naturally guarded on-chain - the second
// escrow.withdraw underflows and reverts (Solidity 0.8) - so run one sweep at a time;
// no idempotency store is required for a single operator-run sweep. This lives beside
// slash/refund/withdrawBond as the package's operator-gated on-chain money-movement
// helpers (here PaymentEscrow, not StakingVault).
import { PAYMENT_ESCROW, escrowAbi } from "@utter/chain";
import type { AdminWriter } from "./slash.js";

/**
 * The minimal read/wait surface the sweep needs. `readContract` reads the treasury's
 * accrued balance (PaymentEscrow.balanceOf) BEFORE the write; the optional
 * `waitForTransactionReceipt` keeps the withdraw observable for the operator audit.
 * Matches viem's PublicClient shape so the real Arc public client satisfies it, while
 * the test injects a spy.
 */
export interface PayoutPublicClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: "balanceOf";
    args: readonly [`0x${string}`];
  }): Promise<bigint>;
  waitForTransactionReceipt?(args: { hash: `0x${string}` }): Promise<unknown>;
}

/** Injected clients for {@link sweepTreasuryPayout}. */
export interface PayoutDeps {
  /** The TREASURY wallet (escrow.withdraw is msg.sender-scoped). Operator-gated key. */
  admin: AdminWriter;
  /** The read-path client for the accrued balance + the receipt wait. */
  publicClient: PayoutPublicClient;
}

/** The outcome of a {@link sweepTreasuryPayout} call. */
export interface SweepResult {
  /** The accrued treasury balance read on-chain (USDC base units). */
  accrued: bigint;
  /** The amount withdrawn in THIS call (0n when nothing was swept). */
  withdrawn: bigint;
  /** The withdraw tx hash, or null when nothing was swept (zero / below threshold). */
  tx: `0x${string}` | null;
}

/**
 * Sweep the platform treasury's accrued PaymentEscrow balance to the treasury wallet.
 * Reads escrow.balanceOf[treasury] and, when it is at/above `minThreshold` (and not
 * zero), submits escrow.withdraw(balance) through the injected AdminWriter. The
 * AdminWriter MUST be the treasury wallet (withdraw is msg.sender-scoped), so the full
 * accrued balance lands in the treasury wallet.
 *
 * No write happens when the accrued balance is zero or below the threshold (returns
 * tx: null). The withdraw amount IS the read balance - no scaling, no decimals literal.
 * Live broadcast is operator-gated; the autonomous suite injects a mock AdminWriter.
 *
 * @throws if `minThreshold` is negative.
 */
export async function sweepTreasuryPayout(
  deps: PayoutDeps,
  opts: { treasury: `0x${string}`; minThreshold?: bigint },
): Promise<SweepResult> {
  const threshold = opts.minThreshold ?? 0n;
  if (threshold < 0n) {
    throw new Error("sweepTreasuryPayout: minThreshold must be a non-negative bigint (base units)");
  }

  // Read the treasury's accrued escrow balance BEFORE any write. This IS the withdraw
  // amount - never scaled, never derived from a decimals literal.
  const accrued = await deps.publicClient.readContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [opts.treasury],
  });

  // Nothing to sweep (empty) or below the operator's threshold: NO write. The on-chain
  // withdraw would itself revert on a zero amount (ZeroAmount), but guarding here means
  // the empty/below-threshold case is a clean no-op with no broadcast.
  if (accrued === 0n || accrued < threshold) {
    return { accrued, withdrawn: 0n, tx: null };
  }

  // Sweep the full accrued balance. The AdminWriter is the treasury wallet, so
  // msg.sender == treasury and the USDC lands in the treasury wallet.
  const tx = await deps.admin.writeContract({
    address: PAYMENT_ESCROW,
    abi: escrowAbi,
    functionName: "withdraw",
    args: [accrued],
  });
  if (deps.publicClient.waitForTransactionReceipt) {
    await deps.publicClient.waitForTransactionReceipt({ hash: tx });
  }

  return { accrued, withdrawn: accrued, tx };
}
