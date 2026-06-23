// AddressPill - a truncated mono address with a copy affordance. Addresses are mono
// (the money/hash discipline). The component only renders + copies the address it is
// given; it never derives or checksums identity (read-through mandate).
import * as React from "react";

export interface AddressPillProps {
  /** A 0x-prefixed address or hash. */
  address: string;
  /** Leading chars to keep before the ellipsis (default 6, i.e. "0x" + 4). */
  lead?: number;
  /** Trailing chars to keep (default 4). */
  tail?: number;
  /** Show a copy button (default true). Canonical comp name. */
  copy?: boolean;
  /** Back-compat alias for `copy` (default true). `copy` wins when both are set. */
  copyable?: boolean;
  className?: string;
}

function truncate(address: string, lead: number, tail: number): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function AddressPill({
  address,
  lead = 6,
  tail = 4,
  copy,
  copyable = true,
  className,
}: AddressPillProps): React.ReactElement {
  // `copy` is the canonical comp prop; fall back to the legacy `copyable` alias.
  const showCopy = copy ?? copyable;
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(address);
    }
    setCopied(true);
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [address]);

  return (
    <span
      data-testid="address-pill"
      className={[
        "inline-flex items-center gap-xs",
        "border border-hairline bg-raised",
        "px-xs py-2xs",
        "font-mono text-caption-mono text-ink",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span title={address}>{truncate(address, lead, tail)}</span>
      {showCopy ? (
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "copied" : "copy address"}
          className="text-ink-faint hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-blue lowercase"
        >
          {copied ? "copied" : "copy"}
        </button>
      ) : null}
    </span>
  );
}
