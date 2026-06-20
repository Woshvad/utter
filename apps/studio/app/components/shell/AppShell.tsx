// AppShell - the persistent authed layout: a 240px left sidebar (logo lockup +
// primary nav Create/Discover/Dashboard/Wallet + a "your resources" list with
// square status dots) and a 64px top bar, wrapping the routed page content. Density
// swaps per surface are the page's concern; the shell holds the constants.
import * as React from "react";
import { SidebarNavItem } from "./SidebarNavItem";
import { TopBar, type TopBarProps } from "./TopBar";
import type { StatusState } from "../primitives/StatusDot";

export interface NavEntry {
  label: string;
  href: string;
  active?: boolean;
}

export interface ResourceEntry {
  label: string;
  href: string;
  status: StatusState;
}

export interface AppShellProps {
  /** Primary nav (Create / Discover / Dashboard / Wallet). */
  nav: NavEntry[];
  /** "Your resources" list rows (each with a square status dot). */
  resources?: ResourceEntry[];
  /** Props forwarded to the top bar (escrow pill, account, actions). */
  topBar?: TopBarProps;
  children: React.ReactNode;
}

function LogoLockup(): React.ReactElement {
  // circle (red) + triangle (ink) + wordmark - the Bauhaus brand glyph
  return (
    <div className="flex items-center gap-xs px-md py-lg">
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
      <span className="text-heading font-display font-bold tracking-tighter text-ink lowercase">
        utter
      </span>
    </div>
  );
}

export function AppShell({
  nav,
  resources,
  topBar,
  children,
}: AppShellProps): React.ReactElement {
  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <aside className="flex w-sidebar flex-none flex-col border-r border-hairline bg-canvas">
        <LogoLockup />
        <nav aria-label="primary" className="flex flex-col">
          {nav.map((n) => (
            <SidebarNavItem key={n.href} label={n.label} href={n.href} active={n.active} />
          ))}
        </nav>
        {resources && resources.length > 0 ? (
          <div className="mt-lg">
            <div className="px-md py-xs text-caption-mono font-mono text-ink-faint lowercase">
              your resources
            </div>
            <nav aria-label="your resources" className="flex flex-col">
              {resources.map((r) => (
                <SidebarNavItem
                  key={r.href}
                  label={r.label}
                  href={r.href}
                  status={r.status}
                />
              ))}
            </nav>
          </div>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar {...topBar} />
        <main className="min-w-0 flex-1 overflow-auto p-xl">{children}</main>
      </div>
    </div>
  );
}
