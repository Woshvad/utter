// @utter/staking - the StakingVault bond + takedown client (STK-01/02/03). It
// reads/writes the deployed StakingVault (bond deposit, slash into the insurance
// pool, refund, cooldown withdraw) and the ResourceRegistry pause/slashAuthorization
// using stakingVaultAbi + registryAbi from @utter/chain. All amounts are USDC base
// units; no 6/1e6 literal appears in any amount-math path (Pitfall 3).
//
// On-chain writes go through INJECTABLE clients (the facilitator settle/relayer
// pattern) so the autonomous suite proves the logic against a MOCK chain; LIVE
// broadcast (slash/refund on Arc) is OPERATOR-GATED (keys only from .env.local).

// STK-01: the bond gate over the on-chain bonds() read.
export {
  createBondGate,
  PublishRejected,
  MIN_BOND_BASE_UNITS,
  type PublishRejectedReason,
  type BondReader,
  type BondGateOpts,
  type BondGate,
} from "./gate.js";

// STK-02: the slash trigger - advisory slashAuthorization + the direct admin spend.
export {
  triggerSlash,
  type AdminWriter,
  type SlashPublicClient,
  type SlashDeps,
  type SlashResult,
} from "./slash.js";

// STK-03 + W-1: insurance refund accounting + the honest-creator withdraw passthrough.
export {
  identifyAffectedBuyers,
  executeRefund,
  withdrawBond,
  refundBatchIdemKey,
  InMemoryRefundIdempotencyStore,
  type SettledPayment,
  type FailureWindow,
  type AffectedBuyer,
  type PoolReader,
  type RefundDeps,
  type RefundResult,
  type RefundIdempotencyStore,
  type WithdrawDeps,
} from "./refund.js";

// MAINNET section 5: the operator-gated TREASURY fee sweep (escrow.withdraw the
// platform's accrued 30 percent cut to the treasury wallet; pull-payment, treasury-only).
export {
  sweepTreasuryPayout,
  type PayoutDeps,
  type PayoutPublicClient,
  type SweepResult,
} from "./payout.js";
