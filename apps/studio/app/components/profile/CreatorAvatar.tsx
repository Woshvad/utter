// CreatorAvatar - the creator identity disc on /creators/:address (comp 696): an 88px
// blue circle with a 4px canvas overlap ring and a single bold white initial derived
// deterministically from the address. There is no avatar/identicon primitive and the
// brief forbids stock photography, so the identity is schema-derived (the address, not a
// photo). The same creator always renders the same initial; no network read, no new dep.
import * as React from "react";

export interface CreatorAvatarProps {
  /** The creator address the initial is derived from. */
  address: string;
  /** Diameter in pixels of the circle (default 88). */
  size?: number;
  className?: string;
}

/**
 * A stable display initial for the address: the first hex char after 0x uppercased
 * (a deterministic, at-a-glance identity), falling back to "0" for a malformed value.
 */
function addressInitial(address: string): string {
  const stripped = address.toLowerCase().startsWith("0x") ? address.slice(2) : address;
  const first = stripped.charAt(0);
  return (first || "0").toUpperCase();
}

export function CreatorAvatar({
  address,
  size = 88,
  className,
}: CreatorAvatarProps): React.ReactElement {
  const initial = addressInitial(address);
  // The single initial scales with the disc (comp uses 32px on an 88px circle).
  const fontSize = Math.round(size * (32 / 88));

  return (
    <div
      data-testid="creator-avatar"
      role="img"
      aria-label={`creator identity ${address}`}
      className={[
        "flex flex-none items-center justify-center rounded-full border-[4px] border-canvas bg-blue font-bold text-white",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size, fontSize }}
    >
      {initial}
    </div>
  );
}
