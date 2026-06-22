// CreatorAvatar - a deterministic geometric Bauhaus identity block derived from an
// address. There is no avatar/identicon primitive in the design system and the brief
// forbids stock photography, so the creator's identity is rendered as schema-derived
// art: the triad shapes (circle/square/triangle) placed by a cheap deterministic hash
// of the address, mirroring the SpecPreviewTile pattern in ResourceCard. The fills are
// the existing CSS tokens; no photo, no new dependency.
import * as React from "react";

export interface CreatorAvatarProps {
  /** The creator address the identity block is derived from (the hash seed). */
  address: string;
  /** Side length in pixels of the square frame (default 64). */
  size?: number;
  className?: string;
}

/** A cheap deterministic hash of the seed string, mirroring SpecPreviewTile. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

export function CreatorAvatar({
  address,
  size = 64,
  className,
}: CreatorAvatarProps): React.ReactElement {
  // Deterministic placements from the address hash so the same creator always renders
  // the same block (an at-a-glance identity), with no randomness or network read.
  const h = hashSeed(address);
  const a = h % 3;
  const b = (h >> 3) % 3;
  const c = (h >> 6) % 3;

  return (
    <span
      data-testid="creator-avatar"
      className={["inline-block border border-hairline bg-raised", className]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={`creator identity ${address}`}
      >
        <rect width="100" height="100" fill="var(--canvas)" />
        <circle cx={30 + a * 8} cy="38" r="13" fill="var(--red)" />
        <rect x={50 + b * 6} y="26" width="20" height="20" fill="var(--blue)" />
        <polygon
          points={`${36 + c * 4},58 ${50 + c * 4},78 ${22 + c * 4},78`}
          fill="var(--yellow)"
        />
      </svg>
    </span>
  );
}
