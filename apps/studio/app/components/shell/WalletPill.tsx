// WalletPill - the shell's escrow pill (STU-06 / UI-SPEC §shell): mono escrow USDC +
// a truncated, copyable address. Money renders via the single UsdcAmount surface
// (6dp-aware; decimals from the runtime read - no literal). This is the standalone,
// composable version of the inline pill the TopBar renders; the wallet route and the
// shell both use it so the escrow figure has one render path.
//
// Wallet state is client-only; to avoid the SSR hydration flash (Pitfall 6 /
// T-06-HYDRATION) the caller renders this behind a mounted guard (or passes no
// account during SSR, in which case the pill renders the neutral disconnected state).
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { AddressPill } from "../primitives/AddressPill";

export interface WalletPillProps {
  /** Escrow balance in base units (from useEscrowBalance), or undefined. */
  escrowBaseUnits?: bigint;
  /** Runtime USDC decimals; required when escrowBaseUnits is present. */
  escrowDecimals?: number;
  /** The connected account address (truncated + copyable), or undefined. */
  account?: string;
  className?: string;
}

export function WalletPill({
  escrowBaseUnits,
  escrowDecimals,
  account,
  className,
}: WalletPillProps): React.ReactElement {
  const hasEscrow = escrowBaseUnits !== undefined && escrowDecimals !== undefined;

  if (!account && !hasEscrow) {
    // Neutral disconnected state (SSR-safe): no wallet, no faked figure.
    return (
      <span
        data-testid="wallet-pill"
        data-connected="false"
        className={[
          "inline-flex items-center gap-xs border border-hairline px-xs py-2xs",
          "font-mono text-caption-mono text-ink-faint lowercase",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        not connected
      </span>
    );
  }

  return (
    <span
      data-testid="wallet-pill"
      data-connected="true"
      className={["inline-flex items-center gap-xs", className].filter(Boolean).join(" ")}
    >
      {hasEscrow ? (
        <span className="inline-flex items-center gap-xs border border-hairline px-xs py-2xs font-mono text-caption-mono text-ink-muted lowercase">
          <span className="text-ink-faint">escrow</span>
          <UsdcAmount baseUnits={escrowBaseUnits} decimals={escrowDecimals} />
          <span className="text-ink-faint">usdc</span>
        </span>
      ) : null}
      {account ? <AddressPill address={account} /> : null}
    </span>
  );
}
