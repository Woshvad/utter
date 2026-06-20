// TopBar - the 64px authed top bar: a hard-edged geometric SearchBox, an escrow
// balance WalletPill (mono USDC + truncated address), the `+ utter` red primary
// action, and an account avatar circle. Money is mono + exact via UsdcAmount.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { AddressPill } from "../primitives/AddressPill";

export interface TopBarProps {
  /** Escrow balance in base units (read through getEscrowBalance), or undefined. */
  escrowBaseUnits?: bigint;
  /** Decimals from a runtime read; required when escrowBaseUnits is present. */
  escrowDecimals?: number;
  /** The connected account address (truncated + copyable), or undefined. */
  account?: string;
  /** The global "+ utter" compose action. */
  onUtter?: () => void;
  /** Search query change handler. */
  onSearch?: (q: string) => void;
}

export function TopBar({
  escrowBaseUnits,
  escrowDecimals,
  account,
  onUtter,
  onSearch,
}: TopBarProps): React.ReactElement {
  return (
    <header className="flex h-topbar items-center gap-md border-b border-hairline bg-canvas px-xl">
      {/* geometric search - ink underline, hard-edged */}
      <div className="flex flex-1 items-center">
        <input
          type="search"
          aria-label="search resources"
          placeholder="search resources…"
          onChange={(e) => onSearch?.(e.target.value)}
          className="w-full max-w-md border-0 border-b border-hairline bg-transparent py-xs font-display text-body text-ink placeholder:text-ink-faint outline-none focus-visible:border-blue focus-visible:ring-0"
        />
      </div>

      {/* escrow WalletPill (mono USDC + address) */}
      {escrowBaseUnits !== undefined && escrowDecimals !== undefined ? (
        <span className="inline-flex items-center gap-xs border border-hairline px-xs py-2xs font-mono text-caption-mono text-ink-muted lowercase">
          <span className="text-ink-faint">escrow</span>
          <UsdcAmount baseUnits={escrowBaseUnits} decimals={escrowDecimals} />
          <span className="text-ink-faint">usdc</span>
        </span>
      ) : null}
      {account ? <AddressPill address={account} /> : null}

      {/* + utter primary action (red, triangle-leading) */}
      <button
        type="button"
        onClick={onUtter}
        className="inline-flex items-center gap-xs bg-red px-md py-xs text-label font-display font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue lowercase"
        style={{ color: "#fff" }}
      >
        <span aria-hidden="true">+</span>
        utter
      </button>

      {/* account avatar circle */}
      <span
        aria-hidden="true"
        className="inline-block h-8 w-8 rounded-full border border-hairline bg-raised"
      />
    </header>
  );
}
