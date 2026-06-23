// ChannelHeader - the creator profile header on /creators/:address (comp 688-717):
// a full-bleed 140px Bauhaus banner (blue square / red triangle / yellow ring), the
// 88px CreatorAvatar circle overlapping the banner, an identity block (derived address
// handle + a "verified creator" pill + the address + " · arc testnet" meta + a red
// "+ follow" button), and a seamless 1px 4-up stats grid (APIS / TOTAL CALLS / EARNINGS
// / REPUTATION) whose last cell is a 10-segment meter.
//
// Money discipline: total earnings render ONLY through the single UsdcAmount surface
// (base units + a runtime decimals); there is NO 1e6/6 literal and no hand-formatted
// money here. apiCount and totalCalls are plain integer counts (not USDC). The identity
// handle/verified pill are representative labels (no real display name exists); the
// repScore is derived honestly from the owned cards' uptime by the loader.
import * as React from "react";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { CreatorAvatar } from "./CreatorAvatar";

export interface ChannelHeaderProps {
  /** The creator address (the channel owner). */
  address: string;
  /** An honest 0-100 reputation score derived from card uptime (drives the meter). */
  repScore: number;
  /** Aggregated ERC-8004 feedbackCount across the creator's apis (a count, not money). */
  reputation: bigint;
  /** How many live apis the creator has (a plain integer count). */
  apiCount: number;
  /** Total settled calls across the creator's apis (a plain integer count). */
  totalCalls: number;
  /** Total creator earnings in token base units (rendered only via UsdcAmount). */
  totalEarnings: bigint;
  /** Decimals from a runtime read - the ONLY source of money scale. */
  decimals: number;
}

/** A truncated mono address handle (e.g. 0x1111…1111) used as the display name. */
function addressHandle(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Compact a large integer call count (e.g. 4200000 -> "4.2M"), else group with commas. */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
}

/** One stats cell: a faint mono label over a bold mono value, on bg-raised. */
function StatCell({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="bg-raised p-[18px]">
      <div className="mb-[6px] font-mono text-[11px] text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

export function ChannelHeader({
  address,
  repScore,
  reputation,
  apiCount,
  totalCalls,
  totalEarnings,
  decimals,
}: ChannelHeaderProps): React.ReactElement {
  // Clamp the score and derive the count of filled meter segments (0..10).
  const score = Math.max(0, Math.min(100, Math.round(repScore)));
  const filled = Math.round(score / 10);

  // Client-side follow toggle persisted in localStorage, keyed by the creator address.
  // Initialize false for SSR and sync from storage after mount so the server and first
  // client render agree (no hydration mismatch).
  const followKey = `utter:follow:${address}`;
  const [following, setFollowing] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setFollowing(window.localStorage.getItem(followKey) === "1");
  }, [followKey]);

  const toggleFollow = React.useCallback(() => {
    setFollowing((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        if (next) window.localStorage.setItem(followKey, "1");
        else window.localStorage.removeItem(followKey);
      }
      return next;
    });
  }, [followKey]);

  return (
    <header data-testid="channel-header">
      {/* full-bleed 140px banner with the three comp shapes (comp 689-693). */}
      <div className="relative h-[140px] overflow-hidden border-b border-hairline bg-canvas">
        <div className="absolute left-[60px] top-[30px] h-[80px] w-[80px] bg-blue" />
        <div
          className="absolute left-[200px] top-[20px]"
          style={{
            width: 0,
            height: 0,
            borderLeft: "50px solid transparent",
            borderRight: "50px solid transparent",
            borderBottom: "90px solid var(--red)",
          }}
        />
        <div className="absolute right-[120px] top-[-30px] h-[160px] w-[160px] rounded-full border-[20px] border-yellow" />
      </div>

      {/* inner content wrapper - the 32px gutter that aligns with the apis grid below. */}
      <div className="px-[32px]">
        {/* identity row: the avatar overlaps the banner (mt -36). */}
        <div className="mb-[24px] mt-[-36px] flex items-end gap-[20px]">
          <CreatorAvatar address={address} size={88} />
          <div className="flex-1 pb-[6px]">
            <div className="flex items-center gap-[12px]">
              <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-ink">
                {addressHandle(address)}
              </h1>
              <div
                data-testid="verified-creator-pill"
                className="flex items-center gap-[6px] border border-hairline px-[10px] py-[4px]"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-[8px] w-[8px] rounded-full bg-blue"
                />
                <span className="font-mono text-[11px] text-ink-muted">verified creator</span>
              </div>
            </div>
            <div className="mt-[4px] font-mono text-[12px] text-ink-faint">
              {`${address} · arc testnet`}
            </div>
          </div>
          <button
            type="button"
            onClick={toggleFollow}
            aria-pressed={following}
            className={[
              "ml-auto px-[22px] py-[11px] font-mono text-[14px] font-semibold text-white",
              // Following uses the blue identity role; not-following keeps the red CTA.
              following ? "bg-blue" : "bg-red",
            ].join(" ")}
          >
            {following ? "following" : "+ follow"}
          </button>
        </div>

        {/* seamless 1px 4-up stats grid (comp 707-717). */}
        <div className="mb-[28px] grid grid-cols-4 gap-px border border-hairline bg-hairline">
          <StatCell label="APIS">
            <div className="font-mono text-[22px] font-bold text-ink tabular-nums">{apiCount}</div>
          </StatCell>
          <StatCell label="TOTAL CALLS">
            <div className="font-mono text-[22px] font-bold text-blue tabular-nums">
              {compactCount(totalCalls)}
            </div>
          </StatCell>
          <StatCell label="EARNINGS">
            <UsdcAmount
              baseUnits={totalEarnings}
              decimals={decimals}
              className="text-[22px] font-bold text-yellow"
            />
          </StatCell>
          <StatCell label={`REPUTATION · ${score}/100`}>
            <div
              data-testid="reputation-meter"
              data-score={score}
              className="mt-[6px] flex gap-[3px]"
            >
              {Array.from({ length: 10 }).map((_, i) => (
                <span
                  key={i}
                  className={["h-[12px] flex-1", i < filled ? "bg-red" : "bg-hairline"].join(" ")}
                />
              ))}
            </div>
          </StatCell>
        </div>
      </div>
    </header>
  );
}
