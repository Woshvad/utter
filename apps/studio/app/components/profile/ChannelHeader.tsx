// ChannelHeader - the creator "channel" header on /creators/:address: the deterministic
// CreatorAvatar identity block, the creator address via AddressPill, the ERC-8004
// reputation meter via ReputationBadge, and a totals row (live apis / calls / earnings).
//
// Money discipline: total earnings render ONLY through the single UsdcAmount surface
// (base units + a runtime decimals); there is NO 1e6/6 literal and no hand-formatted
// money here. apiCount and totalCalls are plain integer counts (not USDC), so they
// render as mono tabular-nums digits, never through UsdcAmount.
//
// This composes only existing primitives and design tokens (hard edges, border-hairline,
// bg-raised, gap-* spacing); it invents no new styling. It stacks vertically on small
// screens and lays out horizontally at sm/lg breakpoints (the discover flex idiom).
import * as React from "react";
import { AddressPill } from "../primitives/AddressPill";
import { ReputationBadge } from "../primitives/ReputationBadge";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { CreatorAvatar } from "./CreatorAvatar";

export interface ChannelHeaderProps {
  /** The creator address (the channel owner). */
  address: string;
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

/** One totals cell: a lowercase label over a mono tabular-nums value. */
function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2xs">
      <span className="text-caption-mono font-mono text-ink-faint lowercase">{label}</span>
      <span className="text-heading font-mono tabular-nums text-ink">{children}</span>
    </div>
  );
}

export function ChannelHeader({
  address,
  reputation,
  apiCount,
  totalCalls,
  totalEarnings,
  decimals,
}: ChannelHeaderProps): React.ReactElement {
  return (
    <header
      data-testid="channel-header"
      className="flex flex-col gap-lg border border-hairline bg-raised p-lg sm:flex-row sm:items-center sm:justify-between"
    >
      {/* identity: avatar + address + reputation meter */}
      <div className="flex flex-col gap-md sm:flex-row sm:items-center">
        <CreatorAvatar address={address} size={64} />
        <div className="flex flex-col gap-xs">
          <span className="text-caption-mono font-mono text-ink-faint lowercase">creator</span>
          <AddressPill address={address} />
          <ReputationBadge feedbackCount={reputation} />
        </div>
      </div>

      {/* totals: live apis / calls / earnings. earnings via UsdcAmount only. */}
      <div className="flex flex-row flex-wrap gap-lg lg:gap-xl">
        <Stat label="live apis">{apiCount}</Stat>
        <Stat label="calls">{totalCalls}</Stat>
        <Stat label="earnings">
          <UsdcAmount baseUnits={totalEarnings} decimals={decimals} />
        </Stat>
      </div>
    </header>
  );
}
