// BondReclaimPanel.tsx - the creator "Bond" reclaim panel on the resource detail screen
// (Payout, T59). A creator posts a USDC bond per resource to the StakingVault to publish
// it; to get it back they call requestWithdraw(resourceId) (starts a 7-day on-chain
// COOLDOWN), then withdraw(resourceId) once the cooldown elapses. This panel READS the
// resource's on-chain bond status (useBondStatus) and offers the two-step reclaim
// (useBondWithdraw) for the connected bond owner.
//
// State machine (derived from posted + cooldownEnds + now):
//   none         posted == 0n                              -> read-only status, no controls
//   active       posted > 0n, cooldownEnds == 0n           -> owner sees "Request withdraw"
//   cooling-down cooldownEnds != 0n && now < cooldownEnds  -> shows the unlock time, no claim
//   withdrawable cooldownEnds != 0n && now >= cooldownEnds -> owner sees "Claim bond"
//
// SECURITY BOUNDARY: the on-chain COOLDOWN / NotBondOwner / WithdrawNotRequested guards
// (StakingVault) are the real boundary. The owner-only controls and the cooldown-aware
// buttons here are a UX convenience ONLY - a non-owner or too-early tx still reverts
// on-chain. A non-owner or a no-bond resource sees the read-only status with no controls.
//
// Money discipline: the posted bond is base units + runtime decimals from the read, rendered
// only through UsdcAmount - there is NO 6/1e6 literal. The two bond writes carry the bytes32
// resourceId (NOT an amount), so there is no parseUnits on this path. The Claim is an OUTFLOW,
// so it keeps the WithdrawForm confirm-modal discipline (T-06-OUTFLOW).
import * as React from "react";
import { useAccount } from "wagmi";
import type { Hex } from "../../adapter/types.js";
import { useBondStatus } from "../../wallet/useBondStatus.js";
import { useBondWithdraw } from "../../wallet/useBondWithdraw.js";
import { UsdcAmount } from "../primitives/UsdcAmount";
import { Modal } from "../primitives/Modal";

export interface BondReclaimPanelProps {
  /** The resourceId (bytes32 hex) whose bond is reclaimed. */
  resourceId: Hex;
  /** Fallback runtime USDC decimals (the loader's SSR decimals) used until the bond read
   *  resolves its own runtime decimals. */
  decimals?: number;
}

/** The derived bond reclaim state from the on-chain read + the current time. */
type BondState = "none" | "active" | "cooling-down" | "withdrawable";

/** Format a unix-second timestamp (bigint) to a readable local string for the unlock note. */
function formatUnlock(cooldownEnds: bigint): string {
  return new Date(Number(cooldownEnds) * 1000).toLocaleString();
}

export function BondReclaimPanel({
  resourceId,
  decimals: fallbackDecimals,
}: BondReclaimPanelProps): React.ReactElement {
  const { address, isConnected } = useAccount();

  // A monotonic token bumped after a request/claim confirms so the bond read re-runs.
  // Carries no money value and never scales an amount.
  const [refreshToken, setRefreshToken] = React.useState(0);
  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);

  const bond = useBondStatus({ resourceId, refreshToken });
  const renderDecimals = bond.decimals ?? fallbackDecimals;

  const { request, claim, status, awaitingSignature, confirming, error, reset } =
    useBondWithdraw({ onDone: refresh });

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const busy = awaitingSignature || confirming || status === "requesting" || status === "claiming";

  // The current time in unix seconds, captured once on mount (and bumped on refresh) so the
  // cooling-down vs withdrawable derivation is stable across a render. This is a UX gate
  // only; the on-chain guard is the real cooldown boundary.
  const nowSeconds = React.useMemo(
    () => BigInt(Math.floor(Date.now() / 1000)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshToken],
  );

  // Derive the bond state from the read. Undefined posted (pre-read) is treated as none.
  const posted = bond.posted ?? 0n;
  const cooldownEnds = bond.cooldownEnds ?? 0n;
  const bondState: BondState =
    posted === 0n
      ? "none"
      : cooldownEnds === 0n
        ? "active"
        : nowSeconds < cooldownEnds
          ? "cooling-down"
          : "withdrawable";

  // Owner gate (UX only): the connected wallet equals the bond owner. The on-chain
  // NotBondOwner guard is the real boundary - a non-owner tx reverts regardless.
  const isOwner =
    isConnected &&
    address !== undefined &&
    bond.owner !== undefined &&
    bond.owner.toLowerCase() === address.toLowerCase();

  const onRequest = React.useCallback(() => {
    void request(resourceId);
  }, [request, resourceId]);

  const openClaimConfirm = React.useCallback(() => {
    reset();
    setConfirmOpen(true);
  }, [reset]);

  const confirmClaim = React.useCallback(() => {
    setConfirmOpen(false);
    void claim(resourceId);
  }, [claim, resourceId]);

  const statusLabel =
    awaitingSignature
      ? "awaiting signature in wallet…"
      : status === "requesting"
        ? "requesting withdraw…"
        : status === "claiming"
          ? "claiming bond…"
          : status === "done"
            ? "done"
            : null;

  return (
    <section
      data-testid="bond-reclaim-panel"
      className="flex flex-col gap-[12px] border border-hairline bg-raised p-[24px]"
    >
      <span className="font-mono text-[12px] tracking-[0.06em] text-ink-faint">BOND</span>

      {/* the posted bond amount, mono yellow (money), via UsdcAmount */}
      <div data-testid="bond-posted-amount" className="leading-none">
        {bond.loading || renderDecimals === undefined ? (
          <span className="font-mono tabular-nums text-[28px] font-bold tracking-[-0.02em] text-ink-faint leading-none">
            $—
          </span>
        ) : (
          <UsdcAmount
            baseUnits={posted}
            decimals={renderDecimals}
            className="text-[28px] font-bold tracking-[-0.02em] text-yellow leading-none"
          />
        )}
      </div>

      {/* the human-readable bond state */}
      <span data-testid="bond-state" className="font-mono text-[12px] text-ink-muted lowercase">
        {bondState === "none"
          ? "no bond posted for this resource"
          : bondState === "active"
            ? "bond posted - request a withdraw to start the 7-day cooldown"
            : bondState === "cooling-down"
              ? `cooling down - withdrawable after ${formatUnlock(cooldownEnds)}`
              : "cooldown elapsed - the bond is claimable"}
      </span>

      {/* owner-gated controls (UX convenience; the on-chain guards are the real boundary).
          A non-owner or a no-bond resource sees the read-only status only. */}
      {isOwner && bondState === "active" ? (
        <button
          type="button"
          data-testid="bond-request"
          onClick={onRequest}
          disabled={busy}
          className="border border-hairline bg-transparent p-[13px] font-mono text-[14px] lowercase text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
        >
          request withdraw
        </button>
      ) : null}

      {isOwner && bondState === "withdrawable" ? (
        <button
          type="button"
          data-testid="bond-claim"
          onClick={openClaimConfirm}
          disabled={busy}
          className="border border-hairline bg-transparent p-[13px] font-mono text-[14px] lowercase text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
        >
          claim bond
        </button>
      ) : null}

      {isOwner && bondState === "active" ? (
        <span data-testid="bond-request-note" className="font-mono text-[11px] text-ink-faint lowercase">
          requesting starts the 7-day on-chain cooldown before the bond can be claimed.
        </span>
      ) : null}

      {statusLabel ? (
        <span data-testid="bond-status" className="font-mono text-[11px] text-ink-muted">
          {statusLabel}
        </span>
      ) : null}

      {status === "error" && error ? (
        <span data-testid="bond-error" role="alert" className="font-mono text-[11px] text-red">
          {error}
        </span>
      ) : null}

      {bond.error ? (
        <span data-testid="bond-read-error" role="alert" className="font-mono text-[11px] text-red">
          {bond.error}
        </span>
      ) : null}

      {/* the Claim is an OUTFLOW, so it is confirm-gated like WithdrawForm */}
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="confirm claim bond"
        description="claiming transfers the posted bond out of the staking vault. this is a signed on-chain transaction."
        footer={
          <>
            <button
              type="button"
              data-testid="bond-cancel"
              onClick={() => setConfirmOpen(false)}
              className="border border-hairline px-md py-xs text-label font-display lowercase text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="bond-confirm"
              onClick={confirmClaim}
              className="bg-red px-md py-xs text-label font-display font-semibold lowercase text-white outline-none focus-visible:ring-2 focus-visible:ring-blue"
              style={{ color: "#fff" }}
            >
              claim
            </button>
          </>
        }
      >
        {renderDecimals !== undefined ? (
          <div className="flex items-baseline gap-xs">
            <span className="text-label font-display lowercase text-ink-muted">claiming</span>
            <UsdcAmount baseUnits={posted} decimals={renderDecimals} className="text-heading text-ink" />
            <span className="text-label font-display lowercase text-ink-faint">usdc</span>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
