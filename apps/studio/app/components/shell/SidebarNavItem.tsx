// SidebarNavItem - a single left-sidebar row. Primary nav items get the blue active
// treatment (a blue left rule + raised fill). "Your resources" entries pass a
// `status` so the row carries a square StatusDot (live/building/paused/failed) -
// meaning is shape + color per the a11y rule.
import * as React from "react";
import { StatusDot, type StatusState } from "../primitives/StatusDot";

export interface SidebarNavItemProps {
  label: string;
  href: string;
  active?: boolean;
  /** When present, the row is a resource entry and shows a status dot. */
  status?: StatusState;
  /** Optional leading glyph (geometric icon) for primary nav rows. */
  icon?: React.ReactNode;
}

export function SidebarNavItem({
  label,
  href,
  active,
  status,
  icon,
}: SidebarNavItemProps): React.ReactElement {
  return (
    <a
      href={href}
      data-testid="sidebar-nav-item"
      data-active={active ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center gap-xs px-md py-xs text-label font-display lowercase",
        "outline-none focus-visible:ring-2 focus-visible:ring-blue",
        active
          ? "border-l-2 border-blue bg-raised text-ink"
          : "border-l-2 border-transparent text-ink-muted hover:text-ink",
      ].join(" ")}
    >
      {status ? (
        <StatusDot state={status} showLabel={false} size={8} />
      ) : icon ? (
        <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{label}</span>
    </a>
  );
}
