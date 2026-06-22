// DepositForm.tsx - the user-signed DEPOSIT control (STU-06 inflow). The user types a
// human USDC amount; on submit the useDeposit hook runs approve(PAYMENT_ESCROW, amount)
// then deposit(amount), both signed in the user's own wallet (no server/facilitator).
// Wallet leads yellow (money); deposit is an inflow so there is no destructive confirm
// gate. The base-unit conversion lives in the hook (parseUnits with runtime decimals);
// this component never scales money - it echoes the typed string back to the user and
// renders the live status (awaiting signature / approving / depositing / done / error).
//
// Guard rails: submit is disabled when disconnected, when the amount is <= 0 or
// unparseable, when not on arcTestnet, or while a tx is in flight. The decimals prop is
// the runtime decimals from useEscrowBalance (undefined blocks submit too).
import * as React from "react";
import { useAccount, useChainId } from "wagmi";
import { arcTestnet } from "@utter/chain";
import { useDeposit } from "../../wallet/useDeposit.js";

export interface DepositFormProps {
  /** Runtime USDC decimals (from the escrow balance read). Undefined disables submit. */
  decimals?: number;
  /** Called after the deposit confirms so the parent can refetch the escrow balance. */
  onDeposited?: () => void;
}

/** True when `value` parses to a positive decimal number (cheap client gate; the hook re-validates via parseUnits). */
function isPositiveAmount(value: string): boolean {
  if (!/^\d*\.?\d*$/.test(value.trim())) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

export function DepositForm({ decimals, onDeposited }: DepositFormProps): React.ReactElement {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const onArc = chainId === arcTestnet.id;
  const [amount, setAmount] = React.useState("");

  const { deposit, status, awaitingSignature, confirming, error } = useDeposit({
    decimals,
    onDeposited,
  });

  const busy = awaitingSignature || confirming || status === "approving" || status === "depositing";
  const amountValid = isPositiveAmount(amount);
  const canSubmit = isConnected && onArc && amountValid && decimals !== undefined && !busy;

  const onSubmit = React.useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      void deposit(amount);
    },
    [canSubmit, deposit, amount],
  );

  const statusLabel =
    awaitingSignature || (busy && status === "approving" && !confirming)
      ? "awaiting signature in wallet…"
      : status === "approving"
        ? "approving usdc…"
        : status === "depositing"
          ? "depositing…"
          : status === "done"
            ? "deposited"
            : null;

  return (
    <section data-testid="deposit-form" className="flex flex-col gap-md">
      <span className="text-label font-display lowercase text-ink-muted">deposit</span>

      <form onSubmit={onSubmit} className="flex flex-col gap-xs">
        <div className="flex items-center gap-xs">
          <input
            data-testid="deposit-amount-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            aria-label="deposit amount in usdc"
            className="w-40 border border-hairline bg-transparent px-md py-xs font-mono tabular-nums text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
          />
          <span className="text-label font-display lowercase text-ink-faint">usdc</span>
          <button
            type="submit"
            data-testid="deposit-submit"
            disabled={!canSubmit}
            className="inline-flex items-center bg-yellow px-md py-xs text-label font-display font-semibold lowercase outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
            style={{ color: "var(--paper-ink, #0C0C0D)" }}
          >
            deposit
          </button>
        </div>

        {/* echo the human amount the user is about to sign for (deposit is two signatures) */}
        {amountValid ? (
          <span data-testid="deposit-preview" className="text-caption-mono font-mono text-ink-muted">
            you will approve then deposit{" "}
            <span className="tabular-nums text-ink">{amount}</span> usdc (two wallet signatures)
          </span>
        ) : null}

        {!isConnected ? (
          <span data-testid="deposit-disconnected" className="text-caption-mono font-mono text-ink-faint">
            connect a wallet to deposit
          </span>
        ) : !onArc ? (
          <span data-testid="deposit-wrong-chain" role="alert" className="text-caption-mono font-mono text-red">
            switch to arc testnet to deposit
          </span>
        ) : null}

        {statusLabel ? (
          <span data-testid="deposit-status" className="text-caption-mono font-mono text-ink-muted">
            {statusLabel}
          </span>
        ) : null}

        {status === "error" && error ? (
          <span data-testid="deposit-error" role="alert" className="text-caption-mono font-mono text-red">
            {error}
          </span>
        ) : null}
      </form>
    </section>
  );
}
