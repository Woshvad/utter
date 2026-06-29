// EscrowBalanceWidget - the STU-06 escrow balance card (comp 586-594). The balance
// renders BIG (52px) and mono via the single UsdcAmount surface (6dp-aware; the
// decimals come from the runtime read in useEscrowBalance - no 6/1e6 literal here).
// Wallet leads yellow (money). A faint yellow corner square is the Bauhaus accent.
//
// This card is READ-ONLY: it shows the balance, the connected address pill and the
// "arc testnet" chain label. The deposit/withdraw move-money controls live in the
// deposit card alongside this one (the destructive withdraw confirm stays there).
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { AddressPill } from "../primitives/AddressPill";

export interface EscrowBalanceWidgetProps {
  /** The connected wallet address (rendered as a plain comp pill). Undefined => no pill. */
  address?: string;
  /** Escrow balance in base units (from useEscrowBalance), or undefined while loading. */
  baseUnits?: bigint;
  /** Runtime USDC decimals (from readUsdcBalance). Required to render the amount. */
  decimals?: number;
  /** True while the balance read is in flight. */
  loading?: boolean;
  /** The card header label. Defaults to the wallet USDC balance label; the wallet route
   *  passes "WALLET USDC" to disambiguate it from the withdrawable accrued earnings. */
  label?: string;
}

export function EscrowBalanceWidget({
  address,
  baseUnits,
  decimals,
  loading = false,
  label = "WALLET USDC · BALANCE",
}: EscrowBalanceWidgetProps): React.ReactElement {
  const hasBalance = baseUnits !== undefined && decimals !== undefined;

  return (
    <section
      data-testid="escrow-balance-widget"
      className="relative overflow-hidden border border-hairline bg-raised p-[28px]"
    >
      {/* faint yellow corner square - the Bauhaus money accent (comp 587) */}
      <div
        aria-hidden="true"
        className="absolute right-[-30px] top-[-30px] h-[120px] w-[120px] bg-yellow opacity-[0.08]"
      />

      <div className="mb-[12px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
        {label}
      </div>

      {/* big mono USDC (52px, yellow emphasis - money) */}
      <div data-testid="escrow-balance-amount" className="leading-none">
        {loading || !hasBalance ? (
          <span className="font-mono tabular-nums text-[52px] font-bold tracking-[-0.02em] text-ink-faint leading-none">
            $—
          </span>
        ) : (
          <UsdcAmount
            baseUnits={baseUnits}
            decimals={decimals}
            className="text-[52px] font-bold tracking-[-0.02em] text-yellow leading-none"
          />
        )}
      </div>

      <div className="mt-[16px] flex items-center gap-[8px]">
        {address ? (
          <AddressPill
            address={address}
            copy={false}
            className="border border-hairline px-[10px] py-[6px] text-[12px] text-ink-muted"
          />
        ) : (
          <span className="font-mono text-[12px] text-ink-faint">not connected</span>
        )}
        <span className="font-mono text-[11px] text-ink-faint">arc testnet</span>
      </div>
    </section>
  );
}
