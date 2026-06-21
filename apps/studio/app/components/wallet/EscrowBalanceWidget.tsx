// EscrowBalanceWidget - the STU-06 escrow balance surface. The balance renders BIG
// and mono via the single UsdcAmount surface (6dp-aware; the decimals come from the
// runtime read in useEscrowBalance - no 6/1e6 literal here). Wallet leads yellow
// (money). Deposit and withdraw are user-signed browser txs; withdraw is an OUTFLOW
// and therefore opens a bordered confirm Modal + scrim showing the mono amount before
// signing (never one-click - the destructive-action discipline, T-06-OUTFLOW).
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { Modal } from "../primitives/Modal";

export interface EscrowBalanceWidgetProps {
  /** Escrow balance in base units (from useEscrowBalance), or undefined while loading. */
  baseUnits?: bigint;
  /** Runtime USDC decimals (from readUsdcBalance). Required to render the amount. */
  decimals?: number;
  /** True while the balance read is in flight. */
  loading?: boolean;
  /** Deposit handler (user-signed inflow; no confirm gate required). */
  onDeposit?: () => void;
  /** Withdraw handler (user-signed OUTFLOW; gated behind the confirm modal). */
  onWithdraw?: () => void;
}

export function EscrowBalanceWidget({
  baseUnits,
  decimals,
  loading = false,
  onDeposit,
  onWithdraw,
}: EscrowBalanceWidgetProps): React.ReactElement {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const hasBalance = baseUnits !== undefined && decimals !== undefined;

  const confirmWithdraw = React.useCallback(() => {
    setConfirmOpen(false);
    onWithdraw?.();
  }, [onWithdraw]);

  return (
    <section data-testid="escrow-balance-widget" className="flex flex-col gap-md">
      <span className="text-label font-display lowercase text-ink-muted">escrow balance</span>

      {/* big mono USDC (yellow emphasis - money) */}
      <div data-testid="escrow-balance-amount" className="flex items-baseline gap-xs">
        {loading || !hasBalance ? (
          <span className="font-mono tabular-nums text-display text-ink-faint">$—</span>
        ) : (
          <UsdcAmount
            baseUnits={baseUnits}
            decimals={decimals}
            className="text-display text-yellow"
          />
        )}
        <span className="text-label font-display lowercase text-ink-faint">usdc</span>
      </div>

      <div className="flex items-center gap-xs">
        {/* deposit: inflow, no confirm gate */}
        <button
          type="button"
          data-testid="escrow-deposit"
          onClick={onDeposit}
          className="inline-flex items-center bg-yellow px-md py-xs text-label font-display font-semibold lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue"
          style={{ color: "var(--paper-ink, #0C0C0D)" }}
        >
          deposit
        </button>
        {/* withdraw: OUTFLOW - opens the bordered confirm modal first (never one-click) */}
        <button
          type="button"
          data-testid="escrow-withdraw"
          onClick={() => setConfirmOpen(true)}
          className="inline-flex items-center border border-red px-md py-xs text-label font-display font-semibold text-red lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          withdraw
        </button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="confirm withdraw"
        description="withdrawing moves usdc out of escrow. this is a signed on-chain transaction."
        footer={
          <>
            <button
              type="button"
              data-testid="withdraw-cancel"
              onClick={() => setConfirmOpen(false)}
              className="border border-hairline px-md py-xs text-label font-display lowercase text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="withdraw-confirm"
              onClick={confirmWithdraw}
              className="bg-red px-md py-xs text-label font-display font-semibold lowercase text-white outline-none focus-visible:ring-2 focus-visible:ring-blue"
              style={{ color: "#fff" }}
            >
              withdraw
            </button>
          </>
        }
      >
        {hasBalance ? (
          <div className="flex items-baseline gap-xs">
            <span className="text-label font-display lowercase text-ink-muted">balance</span>
            <UsdcAmount baseUnits={baseUnits} decimals={decimals} className="text-heading text-ink" />
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
