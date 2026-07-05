// TopBar - the 64px authed top bar (comp lines 220-234): a hard-edged 480px search
// box (leading hollow-square glyph), an escrow pill (9px yellow square + yellow mono
// figure, no word labels), the `+ utter` red primary action (white text + leading
// triangle), and a 34px blue account avatar showing the creator initial. Money is
// mono + exact via UsdcAmount.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";

/**
 * Derive a deterministic avatar initial from the connected account address: the first
 * hex character after the 0x prefix, uppercased. Falls back to a neutral dot when no
 * address is present (never a constant letter). This is presentation only - no money or
 * identity is recomputed.
 */
function avatarInitial(account: string | undefined): string {
  if (!account) return "·";
  const hex = account.toLowerCase().startsWith("0x") ? account.slice(2) : account;
  const first = hex.charAt(0);
  return first ? first.toUpperCase() : "·";
}

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
  /** Opens the mobile nav drawer (rendered only below lg; absent -> no hamburger). */
  onMenu?: () => void;
}

export function TopBar({
  escrowBaseUnits,
  escrowDecimals,
  account,
  onUtter,
  onSearch,
  onMenu,
}: TopBarProps): React.ReactElement {
  const hasEscrow = escrowBaseUnits !== undefined && escrowDecimals !== undefined;

  // Local controlled query so the search fires on submit (Enter / the search glyph),
  // not on every keystroke. onSearch stays optional, so the input is no-op-safe.
  const [query, setQuery] = React.useState("");

  return (
    <header className="sticky top-0 z-20 flex h-[64px] flex-none items-center gap-[10px] border-b border-hairline bg-canvas px-[16px] lg:gap-[16px] lg:px-[24px]">
      {/* mobile-only hamburger: opens the nav drawer (hidden at lg where the rail shows) */}
      {onMenu ? (
        <button
          type="button"
          onClick={onMenu}
          aria-label="open menu"
          className="-ml-[4px] flex h-[40px] w-[40px] flex-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-blue lg:hidden"
        >
          <span aria-hidden="true" className="flex flex-col gap-[4px]">
            <span className="block h-[2px] w-[18px] bg-ink" />
            <span className="block h-[2px] w-[18px] bg-ink" />
            <span className="block h-[2px] w-[18px] bg-ink" />
          </span>
        </button>
      ) : null}

      {/* hard-edged 480px search box with a leading hollow-square glyph */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch?.(query);
        }}
        className="flex max-w-[480px] flex-1 items-center gap-[10px] border border-hairline bg-raised px-[14px] py-[10px] cursor-text focus-within:ring-2 focus-within:ring-blue"
      >
        <button
          type="submit"
          aria-label="search"
          className="flex-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue"
          style={{ width: 11, height: 11, border: "2px solid var(--ink-faint)", background: "transparent" }}
        />
        <input
          type="search"
          aria-label="search apis, creators, schemas"
          placeholder="search apis, creators, schemas…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border-0 bg-transparent font-display text-[14px] text-ink placeholder:text-ink-faint outline-none focus-visible:ring-0"
        />
      </form>

      {/* spacer pins the right cluster to the edge (comp line 225); on mobile the search
          box fills the row instead, so the spacer only pushes at lg. */}
      <div className="hidden flex-1 lg:block" />

      {/* escrow pill: 9px yellow square + yellow mono figure, no word labels -> /wallet.
          Hidden on mobile (the figure lives in the drawer footer) to save the row. */}
      {hasEscrow ? (
        <a
          href="/wallet"
          className="hidden items-center gap-[10px] border border-hairline px-[14px] py-[9px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue lg:flex"
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
        className="flex flex-none items-center gap-[8px] bg-red px-[14px] py-[10px] text-[14px] font-display font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue lowercase lg:px-[18px]"
        style={{ color: "#fff" }}
      >
        <span aria-hidden="true" className="text-[16px] leading-none">
          +
        </span>
        utter
      </button>

      {account ? (
        // signed in: 34px blue avatar with the account-derived initial -> the creator profile
        <a
          href={`/creators/${account}`}
          aria-label="account"
          data-testid="account-avatar"
          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-blue text-[14px] font-bold text-white cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue"
          style={{ color: "#fff" }}
        >
          {avatarInitial(account)}
        </a>
      ) : (
        // signed out: a NEUTRAL sign-in affordance -> /auth (no fixture identity, no initial)
        <a
          href="/auth"
          aria-label="sign in"
          data-testid="sign-in"
          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border border-hairline bg-raised text-ink-muted cursor-pointer outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-blue"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="8" r="3.2" />
            <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
          </svg>
        </a>
      )}
    </header>
  );
}
