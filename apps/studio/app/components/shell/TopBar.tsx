// TopBar - the 64px authed top bar (comp lines 220-234): a hard-edged 480px search
// box (leading hollow-square glyph), an escrow pill (9px yellow square + yellow mono
// figure, no word labels), the `+ utter` red primary action (white text + leading
// triangle), and a 34px blue account avatar showing the creator initial. Money is
// mono + exact via UsdcAmount.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";

/** The fixture creator used when no connected address is handy (comp avatar -> profile). */
const FIXTURE_CREATOR = "0x1111111111111111111111111111111111111111";

export interface TopBarProps {
  /** Escrow balance in base units (read through getEscrowBalance), or undefined. */
  escrowBaseUnits?: bigint;
  /** Decimals from a runtime read; required when escrowBaseUnits is present. */
  escrowDecimals?: number;
  /** The connected account address (drives the avatar profile link), or undefined. */
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
  const hasEscrow = escrowBaseUnits !== undefined && escrowDecimals !== undefined;
  const profileAddress = account ?? FIXTURE_CREATOR;

  return (
    <header className="sticky top-0 z-20 flex h-[64px] flex-none items-center gap-[16px] border-b border-hairline bg-canvas px-[24px]">
      {/* hard-edged 480px search box with a leading hollow-square glyph */}
      <div className="flex max-w-[480px] flex-1 items-center gap-[10px] border border-hairline bg-raised px-[14px] py-[10px] cursor-text focus-within:ring-2 focus-within:ring-blue">
        <span
          aria-hidden="true"
          className="flex-none"
          style={{ width: 11, height: 11, border: "2px solid var(--ink-faint)" }}
        />
        <input
          type="search"
          aria-label="search apis, creators, schemas"
          placeholder="search apis, creators, schemas…"
          onChange={(e) => onSearch?.(e.target.value)}
          className="w-full border-0 bg-transparent font-display text-[14px] text-ink placeholder:text-ink-faint outline-none focus-visible:ring-0"
        />
      </div>

      {/* spacer pins the right cluster to the edge (comp line 225) */}
      <div className="flex-1" />

      {/* escrow pill: 9px yellow square + yellow mono figure, no word labels -> /wallet */}
      {hasEscrow ? (
        <a
          href="/wallet"
          className="flex items-center gap-[10px] border border-hairline px-[14px] py-[9px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          <span aria-hidden="true" className="flex-none" style={{ width: 9, height: 9, background: "var(--yellow)" }} />
          <span className="font-mono text-[13px] text-yellow">
            <UsdcAmount baseUnits={escrowBaseUnits} decimals={escrowDecimals} />
          </span>
        </a>
      ) : null}

      {/* + utter primary action (red, white text, triangle-leading) */}
      <button
        type="button"
        onClick={onUtter}
        className="flex items-center gap-[8px] bg-red px-[18px] py-[10px] text-[14px] font-display font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue lowercase"
        style={{ color: "#fff" }}
      >
        <span aria-hidden="true" className="text-[16px] leading-none">
          +
        </span>
        utter
      </button>

      {/* 34px blue account avatar with the creator initial -> profile */}
      <a
        href={`/creators/${profileAddress}`}
        aria-label="account"
        className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-blue text-[14px] font-bold text-white cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue"
        style={{ color: "#fff" }}
      >
        v
      </a>
    </header>
  );
}
