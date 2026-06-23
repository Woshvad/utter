// WalletPill - the shell's escrow pill (STU-06 / comp lines 226-229): a 9px yellow
// square + the escrow USDC figure in yellow mono, no word labels (the comp shows ONLY
// the value). Money renders via the single UsdcAmount surface (6dp-aware; decimals
// from the runtime read - no literal). This is the standalone, composable version of
// the inline pill the TopBar renders; the wallet route and the shell both use it so
// the escrow figure has one render path.
//
// Wallet state is client-only; to avoid the SSR hydration flash (Pitfall 6 /
// T-06-HYDRATION) the caller renders this behind a mounted guard (or passes no
// account during SSR, in which case the pill renders the neutral disconnected state).
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";

export interface WalletPillProps {
  /** Escrow balance in base units (from useEscrowBalance), or undefined. */
  escrowBaseUnits?: bigint;
  /** Runtime USDC decimals; required when escrowBaseUnits is present. */
  escrowDecimals?: number;
  /** The connected account address (drives the connected/disconnected state). */
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
          "inline-flex items-center gap-[10px] border border-hairline px-[14px] py-[9px]",
          "font-mono text-[13px] text-ink-faint lowercase",
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
      className={[
        "inline-flex items-center gap-[10px] border border-hairline px-[14px] py-[9px]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden="true" className="flex-none" style={{ width: 9, height: 9, background: "var(--yellow)" }} />
      {hasEscrow ? (
        <span className="font-mono text-[13px] text-yellow">
          <UsdcAmount baseUnits={escrowBaseUnits} decimals={escrowDecimals} />
        </span>
      ) : null}
    </span>
  );
}
