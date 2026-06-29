// EarningsWithdrawCard.tsx - the creator "Withdrawable earnings" card (Payout, T58).
//
// A creator's per-call split share accrues as PaymentEscrow.balanceOf[creator],
// withdrawable via escrow.withdraw(amount). This card READS that accrued balance for the
// connected creator (useAccruedEarnings) and offers a Withdraw action that REUSES the
// existing escrow.withdraw flow (useWithdraw) - the SAME single user-signed tx the wallet
// route uses, no new/different withdraw path, the creator's own msg.sender pulling their
// own balanceOf. It is DISTINCT from RevenuePanel, which shows HISTORICAL settled revenue
// (getRevenue); this card shows the LIVE withdrawable balance.
//
// Money discipline: the accrued balance is base units + runtime decimals from the read;
// the base-unit conversion for the tx lives in useWithdraw (parseUnits with the runtime
// decimals). Every amount renders through the single UsdcAmount surface - no 6/1e6 literal.
//
// Confirm-gated outflow (T-06-OUTFLOW): the withdraw is an OUTFLOW, so it is gated behind a
// bordered, destructive-styled confirm Modal before the signed tx runs, mirroring
// WithdrawForm exactly. On a confirmed withdraw the accrued read refreshes (refreshToken).
import * as React from "react";
import { parseUnits, formatUnits } from "viem";
import { useAccount, useChainId } from "wagmi";
import { arcTestnet } from "@utter/chain";
import { useAccruedEarnings } from "../../wallet/useAccruedEarnings.js";
import { useWithdraw } from "../../wallet/useWithdraw.js";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { Modal } from "../primitives/Modal";

export interface EarningsWithdrawCardProps {
  /** The connected creator address, or undefined when no wallet is connected. */
  address?: string;
  /** Fallback runtime USDC decimals (e.g. the dashboard loader's SSR decimals) used until
   *  the accrued read resolves its own runtime decimals. */
  decimals?: number;
}

/** True when `value` parses to a positive decimal number (the hook re-validates via parseUnits). */
function isPositiveAmount(value: string): boolean {
  if (!/^\d*\.?\d*$/.test(value.trim())) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/** Parse a human amount to base units with the runtime decimals, or undefined if unparseable. */
function tryParse(value: string, decimals: number): bigint | undefined {
  try {
    return parseUnits(value, decimals);
  } catch {
    return undefined;
  }
}

export function EarningsWithdrawCard({
  address,
  decimals: fallbackDecimals,
}: EarningsWithdrawCardProps): React.ReactElement {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const onArc = chainId === arcTestnet.id;
  const [amount, setAmount] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // A monotonic token bumped after a withdraw confirms so the accrued read re-runs. Carries
  // no money value and never scales an amount.
  const [refreshToken, setRefreshToken] = React.useState(0);
  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);

  // Read the connected creator's accrued (withdrawable) escrow balance.
  const accrued = useAccruedEarnings({ address, refreshToken });
  // Prefer the runtime-read decimals; fall back to the passed SSR decimals.
  const renderDecimals = accrued.decimals ?? fallbackDecimals;

  const { withdraw, status, awaitingSignature, confirming, error, reset } = useWithdraw({
    decimals: renderDecimals,
    onWithdrawn: refresh,
  });

  const busy = awaitingSignature || confirming || status === "withdrawing";

  // Base-unit comparison via runtime decimals (no literal). overBalance when the typed
  // amount parses above the accrued withdrawable balance.
  const amountBase =
    renderDecimals !== undefined && isPositiveAmount(amount)
      ? tryParse(amount, renderDecimals)
      : undefined;
  const overBalance =
    amountBase !== undefined && accrued.raw !== undefined && amountBase > accrued.raw;

  const amountValid = isPositiveAmount(amount) && amountBase !== undefined && !overBalance;
  const canSubmit =
    isConnected &&
    onArc &&
    amountValid &&
    renderDecimals !== undefined &&
    accrued.raw !== undefined &&
    !busy;

  const setMax = React.useCallback(() => {
    if (accrued.raw === undefined || renderDecimals === undefined) return;
    // "max" = the full accrued balance, formatted back with the SAME runtime decimals.
    setAmount(formatUnits(accrued.raw, renderDecimals));
  }, [accrued.raw, renderDecimals]);

  const openConfirm = React.useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      reset();
      setConfirmOpen(true);
    },
    [canSubmit, reset],
  );

  const confirmWithdraw = React.useCallback(() => {
    setConfirmOpen(false);
    void withdraw(amount);
  }, [withdraw, amount]);

  const statusLabel = awaitingSignature
    ? "awaiting signature in wallet…"
    : status === "withdrawing"
      ? "withdrawing…"
      : status === "done"
        ? "withdrawn"
        : null;

  return (
    <section
      data-testid="earnings-withdraw-card"
      className="mb-[16px] flex flex-col gap-[12px] border border-hairline bg-raised p-[24px]"
    >
      <span className="font-mono text-[12px] tracking-[0.06em] text-ink-faint">
        WITHDRAWABLE EARNINGS
      </span>

      {/* the live accrued (withdrawable) balance, big mono yellow (money), via UsdcAmount */}
      <div data-testid="earnings-accrued-amount" className="leading-none">
        {accrued.loading || accrued.raw === undefined || renderDecimals === undefined ? (
          <span className="font-mono tabular-nums text-[36px] font-bold tracking-[-0.02em] text-ink-faint leading-none">
            $—
          </span>
        ) : (
          <UsdcAmount
            baseUnits={accrued.raw}
            decimals={renderDecimals}
            className="text-[36px] font-bold tracking-[-0.02em] text-yellow leading-none"
          />
        )}
      </div>

      <form onSubmit={openConfirm} className="flex flex-col gap-[12px]">
        <div className="flex border border-hairline">
          <input
            data-testid="earnings-amount-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            aria-label="withdraw earnings amount in usdc"
            className="flex-1 bg-transparent px-[14px] py-[13px] font-mono text-[16px] tabular-nums text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="earnings-max"
            onClick={setMax}
            disabled={accrued.raw === undefined || renderDecimals === undefined || busy}
            className="border-l border-hairline px-[14px] py-[13px] font-mono text-[12px] lowercase text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
          >
            max
          </button>
        </div>

        <button
          type="submit"
          data-testid="earnings-withdraw-submit"
          disabled={!canSubmit}
          className="border border-hairline bg-transparent p-[13px] font-mono text-[14px] lowercase text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
        >
          withdraw earnings
        </button>

        {accrued.raw !== undefined && renderDecimals !== undefined ? (
          <span data-testid="earnings-available" className="font-mono text-[11px] text-ink-muted">
            available <UsdcAmount baseUnits={accrued.raw} decimals={renderDecimals} /> usdc
          </span>
        ) : null}

        {overBalance ? (
          <span data-testid="earnings-over-balance" role="alert" className="font-mono text-[11px] text-red">
            amount exceeds withdrawable earnings
          </span>
        ) : null}

        {!isConnected ? (
          <span data-testid="earnings-disconnected" className="font-mono text-[11px] text-ink-faint">
            connect a wallet to withdraw earnings
          </span>
        ) : !onArc ? (
          <span data-testid="earnings-wrong-chain" role="alert" className="font-mono text-[11px] text-red">
            switch to arc testnet to withdraw
          </span>
        ) : null}

        {statusLabel ? (
          <span data-testid="earnings-status" className="font-mono text-[11px] text-ink-muted">
            {statusLabel}
          </span>
        ) : null}

        {status === "error" && error ? (
          <span data-testid="earnings-error" role="alert" className="font-mono text-[11px] text-red">
            {error}
          </span>
        ) : null}
      </form>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="confirm withdraw"
        description="withdrawing moves your accrued earnings out of escrow. this is a signed on-chain transaction."
        footer={
          <>
            <button
              type="button"
              data-testid="earnings-cancel"
              onClick={() => setConfirmOpen(false)}
              className="border border-hairline px-md py-xs text-label font-display lowercase text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="earnings-confirm"
              onClick={confirmWithdraw}
              className="bg-red px-md py-xs text-label font-display font-semibold lowercase text-white outline-none focus-visible:ring-2 focus-visible:ring-blue"
              style={{ color: "#fff" }}
            >
              withdraw
            </button>
          </>
        }
      >
        {amountBase !== undefined && renderDecimals !== undefined ? (
          <div className="flex items-baseline gap-xs">
            <span className="text-label font-display lowercase text-ink-muted">withdrawing</span>
            <UsdcAmount baseUnits={amountBase} decimals={renderDecimals} className="text-heading text-ink" />
            <span className="text-label font-display lowercase text-ink-faint">usdc</span>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
