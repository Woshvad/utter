// ErrorState - the branded dark-Bauhaus error block. Error is the red triangle: a
// CSS-border glyph (shape + color, never color alone) mirroring the ErrorLine mark in
// Composer.tsx, paired with a display-font heading, a plain lowercase message, and an
// optional recovery anchor styled like the existing bordered ghost buttons.
//
// This primitive is deliberately framework-free: it uses a plain <a href> for the
// recovery link, not react-router's Link, so the root ErrorBoundary can render it even
// when the router/providers are unavailable during a failed data load. It reuses only
// existing tokens (text-ink, text-ink-muted, font-display, var(--red), border-hairline,
// bg-raised, the spacing scale); it invents no new color and renders no money.
import * as React from "react";

export interface ErrorStateProps {
  /** The terse display heading (e.g. "not found", "something broke"). */
  heading: string;
  /** A plain, specific message shown to the user. Never a raw stack/error dump. */
  message: string;
  /** Optional recovery href (e.g. "/discover", "/"). Omit for no recovery link. */
  actionHref?: string;
  /** The recovery link label (paired with actionHref). */
  actionLabel?: string;
}

export function ErrorState({
  heading,
  message,
  actionHref,
  actionLabel,
}: ErrorStateProps): React.ReactElement {
  return (
    <div
      data-testid="error-state"
      role="alert"
      className="flex flex-col items-start gap-md border border-hairline bg-raised p-2xl"
    >
      {/* the red triangle is the system's error mark - shape + color together */}
      <div className="flex items-center gap-sm">
        <span
          data-testid="error-state-triangle"
          aria-hidden="true"
          style={{
            width: 0,
            height: 0,
            borderLeft: "9px solid transparent",
            borderRight: "9px solid transparent",
            borderBottom: "16px solid var(--red)",
          }}
        />
        <h1 className="text-display-sm font-display lowercase text-ink">{heading}</h1>
      </div>

      <p className="text-body text-ink-muted lowercase">{message}</p>

      {actionHref ? (
        <a
          href={actionHref}
          className="border border-hairline px-md py-xs text-label font-display lowercase text-ink-muted"
        >
          {actionLabel ?? "go back"}
        </a>
      ) : null}
    </div>
  );
}
