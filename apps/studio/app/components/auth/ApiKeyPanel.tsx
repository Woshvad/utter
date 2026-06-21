// ApiKeyPanel - STU-05 / D-STU-05 API-key UI (shown once, then masked).
//
// The shown-once discipline made visible: when a key is freshly minted the panel
// renders the RAW key with a copy action and an explicit "you won't see this again"
// warning; thereafter (and for any previously-minted key) it renders only a masked
// reference (the `utk_` prefix + a fixed dot run). The raw key is held in component
// state ONLY for the lifetime of the mint reveal and is never echoed to a log.
//
// This is a presentational component: minting/hashing/persistence happen server-side
// (apikey.server.ts). The panel receives the freshly-minted raw via `mintedRaw` (the
// one-time reveal) and the list of masked references via `existing`.
import * as React from "react";

export interface ApiKeyPanelProps {
  /** The freshly-minted raw key to reveal ONCE, or null when nothing was just minted. */
  mintedRaw?: string | null;
  /** Masked references for previously-minted keys (e.g. "utk_••••" + a short id). */
  existing?: string[];
  /** Trigger a server mint (the route action); the panel only renders the result. */
  onMint?: () => void;
}

/** Mask a raw key to its prefix + a fixed dot run (never reveals the body). */
function maskKey(prefix = "utk_"): string {
  return `${prefix}${"•".repeat(8)}`;
}

export function ApiKeyPanel({
  mintedRaw,
  existing = [],
  onMint,
}: ApiKeyPanelProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(() => {
    if (mintedRaw && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(mintedRaw);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [mintedRaw]);

  return (
    <section
      data-testid="api-key-panel"
      className="flex flex-col gap-md border border-hairline bg-raised p-lg"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-heading font-display lowercase text-ink">api keys</h2>
        <button
          type="button"
          onClick={onMint}
          className="border border-blue px-sm py-2xs font-mono text-caption-mono text-blue outline-none hover:bg-blue hover:text-paper focus-visible:ring-2 focus-visible:ring-blue lowercase"
        >
          mint key
        </button>
      </div>

      {mintedRaw ? (
        <div
          data-testid="api-key-reveal"
          className="flex flex-col gap-xs border border-yellow bg-canvas p-md"
        >
          {/* the shown-once reveal: raw key + the explicit warning */}
          <span className="font-display text-label lowercase text-yellow">
            copy now — you won&apos;t see this again
          </span>
          <div className="flex items-center justify-between gap-sm">
            <code
              data-testid="api-key-raw"
              className="overflow-x-auto whitespace-nowrap font-mono text-caption-mono text-ink"
            >
              {mintedRaw}
            </code>
            <button
              type="button"
              onClick={onCopy}
              aria-label={copied ? "copied" : "copy api key"}
              className="shrink-0 font-mono text-caption-mono text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-blue lowercase"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        </div>
      ) : null}

      {/* previously-minted keys: masked references only, never the raw body */}
      <ul data-testid="api-key-list" className="flex flex-col gap-2xs">
        {existing.length === 0 ? (
          <li className="font-mono text-caption-mono text-ink-faint lowercase">
            no keys yet
          </li>
        ) : (
          existing.map((ref, i) => (
            <li
              key={i}
              data-testid="api-key-masked"
              className="font-mono text-caption-mono text-ink-muted"
            >
              {ref || maskKey()}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
