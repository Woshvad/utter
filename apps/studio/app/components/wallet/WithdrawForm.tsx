// WithdrawForm.tsx - the user-signed WITHDRAW control (STU-06 OUTFLOW). The user types a
// human USDC amount (capped at the current escrow balance, with a "max" shortcut); the
// withdraw is an OUTFLOW so it is gated behind a bordered confirm Modal (red accent, per
// the wallet destructive-action discipline, T-06-OUTFLOW) before the single signed
// withdraw(amount) tx runs in the user's own wallet (no server/facilitator).
//
// Money discipline: the cap comparison and the "max" value both go through viem
// parseUnits/formatUnits with the RUNTIME decimals (no 6/1e6 literal); the hook does the
// base-unit conversion for the actual tx. Guard rails: submit is disabled when
// disconnected, when the amount is <= 0 or unparseable, when it exceeds the escrow
// balance, when not on arcTestnet, or while the tx is in flight.
import * as React from "react";
import { parseUnits, formatUnits } from "viem";
import { useAccount, useChainId } from "wagmi";
import { arcTestnet } from "@utter/chain";
import { useWithdraw } from "../../wallet/useWithdraw.js";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { Modal } from "../primitives/Modal";

export interface WithdrawFormProps {
  /** Current escrow balance in base units (the withdraw cap). Undefined disables submit. */
  baseUnits?: bigint;
  /** Runtime USDC decimals (from the escrow balance read). Undefined disables submit. */
  decimals?: number;
  /** Called after the withdraw confirms so the parent can refetch the escrow balance. */
  onWithdrawn?: () => void;
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

export function WithdrawForm({ baseUnits, decimals, onWithdrawn }: WithdrawFormProps): React.ReactElement {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const onArc = chainId === arcTestnet.id;
  const [amount, setAmount] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const { withdraw, status, awaitingSignature, confirming, error, reset } = useWithdraw({
    decimals,
    onWithdrawn,
  });

  const busy = awaitingSignature || confirming || status === "withdrawing";

  // Base-unit comparison via runtime decimals (no literal). overBalance when the typed
  // amount parses above the current escrow balance.
  const amountBase =
    decimals !== undefined && isPositiveAmount(amount) ? tryParse(amount, decimals) : undefined;
  const overBalance =
    amountBase !== undefined && baseUnits !== undefined && amountBase > baseUnits;

  const amountValid = isPositiveAmount(amount) && amountBase !== undefined && !overBalance;
  const canSubmit =
    isConnected && onArc && amountValid && decimals !== undefined && baseUnits !== undefined && !busy;

  const setMax = React.useCallback(() => {
    if (baseUnits === undefined || decimals === undefined) return;
    // "max" = the full escrow balance, formatted back with the SAME runtime decimals.
    setAmount(formatUnits(baseUnits, decimals));
  }, [baseUnits, decimals]);

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
    <section data-testid="withdraw-form" className="flex flex-col gap-[12px]">
      <form onSubmit={openConfirm} className="flex flex-col gap-[12px]">
        {/* compact neutral withdraw amount row (the destructive accent is reserved for
            the confirm-modal action only - the resting card stays neutral per the comp) */}
        <div className="flex border border-hairline">
          <input
            data-testid="withdraw-amount-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            aria-label="withdraw amount in usdc"
            className="flex-1 bg-transparent px-[14px] py-[13px] font-mono text-[16px] tabular-nums text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="withdraw-max"
            onClick={setMax}
            disabled={baseUnits === undefined || decimals === undefined || busy}
            className="border-l border-hairline px-[14px] py-[13px] font-mono text-[12px] lowercase text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
          >
            max
          </button>
        </div>

        <button
          type="submit"
          data-testid="withdraw-submit"
          disabled={!canSubmit}
          className="border border-hairline bg-transparent p-[13px] font-mono text-[14px] lowercase text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
        >
          withdraw
        </button>

        {/* show the available cap (mono, runtime decimals) */}
        {baseUnits !== undefined && decimals !== undefined ? (
          <span data-testid="withdraw-available" className="font-mono text-[11px] text-ink-muted">
            available <UsdcAmount baseUnits={baseUnits} decimals={decimals} /> usdc
          </span>
        ) : null}

        {overBalance ? (
          <span data-testid="withdraw-over-balance" role="alert" className="font-mono text-[11px] text-red">
            amount exceeds escrow balance
          </span>
        ) : null}

        {!isConnected ? (
          <span data-testid="withdraw-disconnected" className="font-mono text-[11px] text-ink-faint">
            connect a wallet to withdraw
          </span>
        ) : !onArc ? (
          <span data-testid="withdraw-wrong-chain" role="alert" className="font-mono text-[11px] text-red">
            switch to arc testnet to withdraw
          </span>
        ) : null}

        {statusLabel ? (
          <span data-testid="withdraw-status" className="font-mono text-[11px] text-ink-muted">
            {statusLabel}
          </span>
        ) : null}

        {status === "error" && error ? (
          <span data-testid="withdraw-error" role="alert" className="font-mono text-[11px] text-red">
            {error}
          </span>
        ) : null}
      </form>

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
        {amountBase !== undefined && decimals !== undefined ? (
          <div className="flex items-baseline gap-xs">
            <span className="text-label font-display lowercase text-ink-muted">withdrawing</span>
            <UsdcAmount baseUnits={amountBase} decimals={decimals} className="text-heading text-ink" />
            <span className="text-label font-display lowercase text-ink-faint">usdc</span>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
