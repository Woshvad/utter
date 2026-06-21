// TxLink - an ArcScan/Blockscout transaction link (STU-04 dashboard).
//
// The explorer base comes from the existing ARC_EXPLORER env (the same value the
// rest of the repo uses for ArcScan links; see .env.example line 8 / SPEC §16). We
// do NOT redefine the explorer URL here - the loader reads ARC_EXPLORER and passes
// the base in, so there is one source of truth. The link renders the truncated hash
// mono (the hash discipline) and points at `${explorer}/tx/${hash}`.
import * as React from "react";

export interface TxLinkProps {
  /** The 0x-prefixed transaction hash. */
  hash: string;
  /** The ArcScan/Blockscout base URL (from ARC_EXPLORER), e.g. https://testnet.arcscan.app */
  explorer: string;
  /** Visible link label; defaults to a truncated hash. */
  label?: string;
  className?: string;
}

/** Truncate a hash to a mono-friendly lead…tail form. */
function truncateHash(hash: string): string {
  if (hash.length <= 13) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/** Join the explorer base and the tx path without a double slash. */
function txUrl(explorer: string, hash: string): string {
  const base = explorer.replace(/\/+$/, "");
  return `${base}/tx/${hash}`;
}

export function TxLink({ hash, explorer, label, className }: TxLinkProps): React.ReactElement {
  const href = txUrl(explorer, hash);
  const cls = [
    "inline-flex items-center gap-2xs",
    "font-mono text-caption-mono text-blue",
    "underline-offset-2 hover:underline",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <a
      data-testid="tx-link"
      data-hash={hash}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={hash}
      className={cls}
    >
      {label ?? truncateHash(hash)}
      <span aria-hidden="true">↗</span>
    </a>
  );
}
