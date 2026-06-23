// SidebarNavItem - a single left-sidebar row. Primary nav items get the comp's
// active treatment: a RED 3px left rule + raised fill + ink text, and a per-item
// geometric glyph colored red when active else ink-faint. "Your resources" entries
// pass a `status` so the row carries a 9px circle/square StatusDot (live/building/
// paused/failed) - meaning is shape + color per the a11y rule.
import * as React from "react";
import { StatusDot, type StatusState } from "../primitives/StatusDot";

/** The five primary-nav glyph kinds, drawn as pure geometry (comp lines 178-197). */
export type NavGlyphKind = "triangle" | "square" | "grid" | "ring" | "hollow";

export interface SidebarNavItemProps {
  label: string;
  href: string;
  active?: boolean;
  /** When present, the row is a resource entry and shows a 9px status dot. */
  status?: StatusState;
  /** The geometric glyph for a primary nav row (colored red when active). */
  glyph?: NavGlyphKind;
}

/** Render the per-item nav glyph in the given color (comp lines 178-197). */
function NavGlyph({ kind, color }: { kind: NavGlyphKind; color: string }): React.ReactElement {
  if (kind === "triangle") {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 0,
          height: 0,
          borderTop: "5px solid transparent",
          borderBottom: "5px solid transparent",
          borderLeft: `9px solid ${color}`,
        }}
      />
    );
  }
  if (kind === "square") {
    return (
      <span aria-hidden="true" style={{ width: 11, height: 11, background: color }} />
    );
  }
  if (kind === "grid") {
    return (
      <span
        aria-hidden="true"
        className="grid grid-cols-2 gap-[2px]"
      >
        <span style={{ width: 5, height: 5, background: color }} />
        <span style={{ width: 5, height: 5, background: color }} />
        <span style={{ width: 5, height: 5, background: color }} />
        <span style={{ width: 5, height: 5, background: color }} />
      </span>
    );
  }
  if (kind === "ring") {
    return (
      <span
        aria-hidden="true"
        className="rounded-full"
        style={{ width: 11, height: 11, border: `2px solid ${color}` }}
      />
    );
  }
  // hollow square (no radius)
  return (
    <span aria-hidden="true" style={{ width: 11, height: 11, border: `2px solid ${color}` }} />
  );
}

export function SidebarNavItem({
  label,
  href,
  active,
  status,
  glyph,
}: SidebarNavItemProps): React.ReactElement {
  const glyphColor = active ? "var(--red)" : "var(--ink-faint)";
  return (
    <a
      href={href}
      data-testid="sidebar-nav-item"
      data-active={active ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center gap-[13px] px-[20px] py-[11px] text-[14px] font-display lowercase cursor-pointer",
        "outline-none focus-visible:ring-2 focus-visible:ring-blue",
        active
          ? "border-l-[3px] border-red bg-raised text-ink"
          : "border-l-[3px] border-transparent text-ink-muted hover:text-ink",
      ].join(" ")}
    >
      {status ? (
        // resource row: a 9px circle (live/identity) or square, color by status
        <StatusDot state={status} showLabel={false} size={9} className="flex-none" />
      ) : glyph ? (
        <span aria-hidden="true" className="flex h-[14px] w-[14px] flex-none items-center justify-center">
          <NavGlyph kind={glyph} color={glyphColor} />
        </span>
      ) : null}
      <span className="truncate">{label}</span>
    </a>
  );
}
