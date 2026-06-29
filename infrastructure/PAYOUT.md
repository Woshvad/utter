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
