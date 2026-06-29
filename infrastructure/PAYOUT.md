# Payout runbook

How the platform collects fees and how creators get paid. This covers the operator-run
treasury fee sweep, the creator pull flow, and bond reclaim. It is the operator surface
called for by MAINNET.md section 5.

## The pull-payment constraint (read this first)

`PaymentEscrow.withdraw(amount)` debits the caller's own internal balance
(`balanceOf[msg.sender]`) and sends the USDC to the caller. There is no push primitive:
the escrow cannot send funds to a third party. Every settle credits the split inline, so
both the creator's 70 percent and the platform's 30 percent accrue as internal escrow
balances that each owner withdraws for itself.

Consequences:

- The operator can sweep ONLY an account whose private key it holds, which is the
  platform treasury. The treasury sweep below withdraws the treasury's own accrued
  balance to the treasury wallet.
- The operator cannot push payouts to creators. Creators self-withdraw their accrued
  earnings (see "Creator earnings" below).

## Treasury fee sweep (operator-run)

The platform's 30 percent cut accrues as `PaymentEscrow.balanceOf[treasury]`. The sweep
reads that accrued balance and, when it is at or above an optional threshold, submits
`escrow.withdraw(balance)` as the treasury wallet, moving the USDC into the treasury
wallet. Amounts are USDC base units; the withdraw amount is exactly the read balance.

The library helper is `sweepTreasuryPayout` in `packages/staking/src/payout.ts`. The
runnable operator script is `packages/staking/examples/treasury-sweep.ts`.

### Environment

Set these in `.env.local` (gitignored). The script reads them from `process.env`; load
`.env.local` with `node --env-file`. There is no `dotenv` dependency.

- `PLATFORM_TREASURY_PRIVATE_KEY` (required): the treasury wallet key. It is the
  `msg.sender` for `escrow.withdraw`, so the treasury swept is exactly this wallet's
  account address. The key is read once and is never logged.
- `ARC_RPC_URL` (optional): override the default Arc Testnet RPC.
- `PAYOUT_MIN_THRESHOLD` (optional): a minimum accrued balance in USDC base units. When
  the accrued balance is below this, the script reports "nothing to sweep" and submits no
  transaction. Omit it to sweep any non-zero balance.

### Run

```
node --env-file=.env.local <runner> packages/staking/examples/treasury-sweep.ts
```

The script confirms it is on Arc Testnet, prints the human accrued balance (decimals read
at runtime), sweeps the full accrued balance, and prints the withdraw transaction and its
ArcScan link. When the balance is zero or below the threshold it prints "nothing to sweep"
and submits nothing.

### Single-account, schedulable

The sweep targets the one platform treasury account, so it is safe to schedule as an
unattended op via a systemd timer or cron. Run one sweep at a time: a concurrent double
sweep's second `escrow.withdraw` underflows and reverts on-chain (Solidity 0.8), so no
idempotency store is needed for a single operator-run sweep.

## Creator earnings (creator self-withdraw)

Creators are not paid by the operator. Each creator's 70 percent share accrues as its own
`PaymentEscrow.balanceOf` and the creator withdraws it itself:

- The studio dashboard "Withdrawable earnings" card shows the accrued escrow balance and
  submits `escrow.withdraw` from the creator's connected wallet.
- The wallet "in escrow (withdrawable)" surface shows the same accrued balance distinct
  from the wallet's USDC token balance.

This is the shipped pull flow (PR #16). The operator has no path to push these funds.

## Bond reclaim (creator self-service)

A creator reclaims a posted bond after the on-chain cooldown:

- The studio resource-detail bond panel walks the creator through the request and, after
  the 7-day cooldown, the claim, both submitted from the creator's connected wallet.
- The equivalent off-chain seam is the `withdrawBond` passthrough in
  `packages/staking/src/refund.ts` (`request` then, after cooldown, `finalize`), which
  submits `StakingVault.requestWithdraw` / `withdraw`. The cooldown, ownership, and
  nothing-to-withdraw guards are enforced on-chain.

## Live payout proof checklist (operator-gated)

This is the end-to-end proof that the payout loop works on a live chain. It is operator-gated:
it spends real testnet USDC and broadcasts irreversible transactions, so it is never run in CI.
The autonomous suites prove the logic against mocks (`packages/staking/test/payout.test.ts`, the
studio payout-history tests, the chain `readWithdrawals` test); this checklist proves the genuine
on-chain `Withdrawn` events. Run it after a money-path E2E has accrued balances (MAINNET.md
section 6 item 2), in order.

Preconditions:

- A funded treasury wallet key in `.env.local` as `PLATFORM_TREASURY_PRIVATE_KEY`, and a creator
  wallet connected in the studio. Both must hold native USDC for gas.
- At least one settle has accrued a treasury balance and a creator balance (run the money-path
  E2E first, or let real calls settle).

### 1. Treasury sweep (operator)

1. Confirm the accrued treasury balance is non-zero (the script prints it, decimals read at runtime).
2. Run the sweep: `node --env-file=.env.local <runner> packages/staking/examples/treasury-sweep.ts`.
3. Confirm the printed ArcScan link shows a `Withdrawn(account = treasury, amount)` event and the
   treasury wallet USDC balance increased by that amount. A second immediate run prints
   "nothing to sweep" (the balance is now zero), proving the sweep is not double-spending.

### 2. Creator self-withdraw (creator, in the studio)

1. Sign in to the studio as the creator and open the dashboard. The "Withdrawable earnings" card
   shows the accrued escrow balance (`PaymentEscrow.balanceOf`), distinct from the wallet USDC.
2. Enter an amount at or below the accrued balance, confirm the destructive-action modal, and sign
   the `escrow.withdraw` transaction in the connected wallet.
3. Confirm on ArcScan that the transaction emitted `Withdrawn(account = creator, amount)` and the
   creator wallet USDC increased.
4. Confirm the withdrawal appears in the dashboard "Payout history" panel (the on-chain `Withdrawn`
   read via `readWithdrawals`), newest first, with the matching amount and an ArcScan link. This is
   the read-side proof that the panel reflects real chain state.

### 3. Bond reclaim (creator, optional)

1. On a resource the creator bonded, open the resource-detail bond panel and request the withdraw
   (this starts the on-chain cooldown and moves no funds).
2. After the 7-day cooldown, claim the bond and confirm the `StakingVault` withdraw on ArcScan.

Pass criteria: a `Withdrawn` event for the treasury (step 1) and for the creator (step 2), the
creator withdrawal visible in the payout-history panel, and (if exercised) the bond returned after
cooldown. The escrow internal balances for the swept accounts read back to zero (or the residual
left below the threshold).
