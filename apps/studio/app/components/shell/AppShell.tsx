// AppShell - the persistent authed layout (comp lines 166-234): a 248px left sidebar
// (clickable logo lockup -> landing, five primary nav rows with distinct geometric
// glyphs + a RED 3px active rule, a "YOUR RESOURCES" list, and an ESCROW footer block
// with a yellow mono figure) and a 64px top bar, wrapping the routed page content.
// Density swaps per surface are the page's concern; the shell holds the constants.
import * as React from "react";
import { SidebarNavItem, type NavGlyphKind } from "./SidebarNavItem";
import { TopBar, type TopBarProps } from "./TopBar";
import { UsdcAmount } from "../primitives/UsdcAmount";
import type { StatusState } from "../primitives/StatusDot";

export interface NavEntry {
  label: string;
  href: string;
  active?: boolean;
  /** Optional explicit glyph; defaults are derived from the label below. */
  glyph?: NavGlyphKind;
}

export interface ResourceEntry {
  label: string;
  href: string;
  status: StatusState;
}

export interface AppShellProps {
  /** Primary nav (create / discover / dashboard / wallet / mcp connect). */
  nav: NavEntry[];
  /** "Your resources" list rows (each with a 9px status dot). */
  resources?: ResourceEntry[];
  /** Props forwarded to the top bar (escrow pill, account, actions). */
  topBar?: TopBarProps;
  children: React.ReactNode;
}

/** Map a known nav label to its comp glyph (comp lines 178-197). */
const LABEL_GLYPH: Record<string, NavGlyphKind> = {
  create: "triangle",
  discover: "square",
  dashboard: "grid",
  wallet: "ring",
  "mcp connect": "hollow",
};

/** The brand glyph lockup (red circle + ink triangle + wordmark), clickable -> /. */
function LogoLockup(): React.ReactElement {
  return (
    <a
      href="/"
      className="flex items-center gap-[10px] border-b border-hairline p-[20px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue"
    >
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{ width: 16, height: 16, background: "var(--red)" }}
      />
      <span
        aria-hidden="true"
        style={{
          width: 0,
          height: 0,
          borderTop: "5px solid transparent",
          borderBottom: "5px solid transparent",
          borderLeft: "9px solid var(--ink)",
        }}
      />
      <span className="text-[18px] font-display font-bold tracking-tighter text-ink lowercase">
        utter
      </span>
    </a>
  );
}

export function AppShell({
  nav,
  resources,
  topBar,
  children,
}: AppShellProps): React.ReactElement {
  const escrowBaseUnits = topBar?.escrowBaseUnits;
  const escrowDecimals = topBar?.escrowDecimals;
  const hasEscrow = escrowBaseUnits !== undefined && escrowDecimals !== undefined;

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <aside className="sticky top-0 flex h-screen w-[248px] flex-none flex-col border-r border-hairline bg-canvas">
        <LogoLockup />

        <nav aria-label="primary" className="flex flex-none flex-col py-[12px]">
          {nav.map((n) => (
            <SidebarNavItem
              key={n.href}
              label={n.label}
              href={n.href}
              active={n.active}
              glyph={n.glyph ?? LABEL_GLYPH[n.label]}
            />
          ))}
        </nav>

        <div className="border-t border-hairline px-[20px] pb-[8px] pt-[18px] font-mono text-[11px] uppercase tracking-[0.06em] text-ink-faint">
          your resources
        </div>
        <nav aria-label="your resources" className="flex-1 overflow-y-auto py-[4px]">
          {resources && resources.length > 0
            ? resources.map((r) => (
                <SidebarNavItem
                  key={r.href}
                  label={r.label}
                  href={r.href}
                  status={r.status}
                />
              ))
            : null}
        </nav>

        {/* ESCROW footer block: the yellow mono figure -> /wallet (same escrow source
            the topbar pill reads; no new fetch). */}
        <a
          href="/wallet"
          className="border-t border-hairline px-[20px] py-[14px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          <div className="mb-[4px] font-mono text-[11px] uppercase tracking-[0.06em] text-ink-faint">
            escrow
          </div>
          <div className="font-mono text-[18px] font-bold text-yellow">
            {hasEscrow ? (
              <UsdcAmount baseUnits={escrowBaseUnits} decimals={escrowDecimals} />
            ) : (
              "—"
            )}
          </div>
        </a>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar {...topBar} />
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
