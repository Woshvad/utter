// types.ts - the injectable StudioDataAdapter seam (the heart of Phase 6).
//
// StudioDataAdapter mirrors the cross-phase pluggable-adapter-with-deterministic-
// test-default pattern (Phase 2 PaymentStore, Phase 3 SandboxRunner, Phase 4
// Generator, Phase 5 ResourceProber). The interface carries a `readonly backend`
// discriminator; selectAdapter(env) returns the deterministic FixtureAdapter by
// default (no network/chain/model) and the operator-gated LiveAdapter only when
// STUDIO_DATA_ADAPTER === "live". Every Studio loader/action reads THROUGH this
// seam; the frontend never re-derives price/identity/bond (the Phase 5 mandate).
//
// All money on this surface is token BASE UNITS (bigint); decimals format is
// applied at render time from a runtime decimals() read - never a 1e6/6/18 literal.
import type { FilterCriteria } from "@utter/marketplace";

/** A 0x-prefixed hex string (on-chain id / address shape), declared locally so the
 *  adapter surface does not take a direct viem runtime dep for a type alias. */
export type Hex = `0x${string}`;

/** Which adapter backend produced a result - the deterministic-default discriminator. */
export type AdapterBackend = "fixture" | "live";

/** The six build-pipeline stages, in order (Generate -> Live). The contract Plan
 *  04's SSE route consumes; the BuildStream UI snaps a block per stage. */
export type BuildStage = "Generate" | "Deploy" | "Verify" | "Mint" | "Publish" | "Live";

/** The ordered stage list - the single source of truth for stage progression. */
export const BUILD_STAGES: readonly BuildStage[] = [
  "Generate",
  "Deploy",
  "Verify",
  "Mint",
  "Publish",
  "Live",
] as const;

/** The status of a single build stage as it streams. */
export type BuildStageStatus = "pending" | "running" | "ok" | "error";

/** One server-sent build event for a stage transition. */
export interface BuildEvent {
  /** Which pipeline stage this event reports. */
  stage: BuildStage;
  /** The stage status at this event. */
  status: BuildStageStatus;
  /** A short, non-secret human log line for the stage (never key/secret material). */
  log: string;
}

/** Pricing model the composer offers (maps to the @utter/x402-arc Pricing shape). */
export type PricingModel = "flat" | "metered";

/** The compose form payload (STU-01): prompt + pricing + bond + payout. All money
 *  fields are base-unit bigint; payout is a checksummed address. */
export interface ComposeSpec {
  /** The plain-English endpoint description. */
  prompt: string;
  /** Flat or metered pricing. */
  pricingModel: PricingModel;
  /** Per-call base price in token base units. */
  basePrice: bigint;
  /** The posted bond in token base units. */
  bond: bigint;
  /** The creator payout address (checksummed). */
  payout: Hex;
}

/** The pricing block projected for the detail view (base units as strings). */
export interface DetailPricing {
  model: string;
  /** Per-call base price in base units (string to avoid precision loss). */
  base: string;
  /** Per-KB price in base units. */
  perKB: string;
  /** The escrow cap in base units. */
  max: string;
}

/** The health block projected from the Scorer. */
export interface DetailHealth {
  verified: boolean;
  /** The rolling 0..1 health score, or null when not yet scored. */
  score: number | null;
}

/** Sandbox reconcile status projected from the deployer. */
export type SandboxStatus = "live" | "deploying" | "degraded" | "down";

/**
 * The resource detail projection (STU-03): card + health + bond + sandbox.
 * Read THROUGH existing services; never re-derived. Includes the `creator` owner
 * address so Plan 06's requireResourceOwner gate has a field to compare against
 * the SIWE-authenticated address.
 */
export interface ResourceDetail {
  /** The on-chain resourceId (bytes32 hex). */
  resourceId: Hex;
  /** The checksummed wallet address that owns the resource - the ownership-gate
   *  field Plan 06 compares against the SIWE-authenticated creator. */
  creator: Hex;
  /** The ERC-8004 agentId (decimal string), projected from the mint. */
  agentId: string;
  /** The discovery slug. */
  slug: string;
  /** The listing category. */
  category: string;
  /** The creator payout address (checksummed). */
  payout: Hex;
  /** Pricing projected from the card x402 block. */
  pricing: DetailPricing;
  /** Health projected from the Scorer. */
  health: DetailHealth;
  /** The posted bond in base units, projected from StakingVault.bonds(). */
  bond: bigint;
  /** Sandbox reconcile status projected from the deployer. */
  sandbox: SandboxStatus;
  /** The absolute URL of the resource's /.well-known/agent-card.json. */
  cardUrl: string;
}

/** A marketplace discovery card (the listMarketplace return row). */
export interface ResourceCardData {
  resourceId: Hex;
  agentId: string;
  slug: string;
  category: string;
  pricing: DetailPricing;
  /** feedbackCount projected from ERC-8004 readReputation. */
  reputation: bigint;
  /** The rolling 0..1 health/uptime. */
  uptime: number;
  /** The posted bond in base units. */
  bond: bigint;
  /** Whether the resource is currently listed for discovery. */
  active: boolean;
}

/** Whether a settlement receipt is a debit (settle) or a refund. */
export type ReceiptKind = "settle" | "refund";

/**
 * One settlement/refund receipt row for the STU-04 dashboard's ArcScan links. The
 * `amount` is the projected receipt amount in base units (NOT recomputed) and `tx`
 * is the on-chain transaction hash the dashboard links to ArcScan. These rows are
 * read THROUGH the facilitator stores via the adapter (deterministic fixtures in the
 * autonomous path); they are never invented at render time.
 */
export interface RevenueReceipt {
  /** The on-chain transaction hash (0x-prefixed) for the ArcScan TxLink. */
  tx: Hex;
  /** settle (debit) or refund. */
  kind: ReceiptKind;
  /** The receipt amount in base units (the projected receipt value, not recomputed). */
  amount: bigint;
  /** The payment idemKey the receipt settled under. */
  idemKey: string;
}

/** The revenue dashboard projection (STU-04). All money is base-unit bigint. */
export interface RevenueSummary {
  resourceId: Hex;
  /** Total settled calls. */
  calls: number;
  /** Gross USDC settled, base units. */
  gross: bigint;
  /** The creator share, base units. */
  creatorShare: bigint;
  /** The platform share, base units. */
  platformShare: bigint;
  /** Total refunded USDC, base units. */
  refunds: bigint;
  /**
   * The settle/refund receipt rows backing the ArcScan TxLinks. Read through the
   * facilitator stores; each carries its own on-chain tx hash. The creator/platform
   * split above equals the sum of the settle receipt amounts (not recomputed here).
   */
  receipts: RevenueReceipt[];
}

/** An escrow USDC balance read (STU-06 / wallet). Base units + runtime decimals. */
export interface UsdcBalance {
  /** Raw on-chain balance in base units. */
  raw: bigint;
  /** Decimals read from the contract at runtime (never a literal). */
  decimals: number;
}

/**
 * A resource's on-chain bond status as read from the StakingVault (Payout, T59).
 * The posted amount is base units; owner is the bond-owner address; cooldownEnds is
 * the unix timestamp after which a requested withdraw may complete (0 = no withdraw
 * requested). The UI derives can-request / can-claim from owner + cooldownEnds + now;
 * the on-chain COOLDOWN / NotBondOwner / WithdrawNotRequested guards are the real
 * security boundary, not this read.
 */
export interface BondStatusView {
  /** The posted bond amount in token base units (bigint). */
  posted: bigint;
  /** The bond owner address. */
  owner: Hex;
  /** The cooldown end timestamp (0 = no withdraw requested). */
  cooldownEnds: bigint;
  /** Decimals read from the contract at runtime (never a literal). */
  decimals: number;
}

/**
 * A playground call result (the 402 pay-flow beat). When `paid` is false because the
 * buyer is unfunded, `paywall` carries the 402 accepts quote the PaywallSheet renders
 * the price from (read-through; never recomputed).
 */
export interface PlaygroundResult {
  /** True iff the call was paid (a debit settled). */
  paid: boolean;
  /** The amount debited in base units (<= cap), or 0n when unpaid. */
  debitAmount: bigint;
  /** The response body the endpoint returned. */
  body: unknown;
  /** The handler response size in bytes (drives the metered ticker), when known. */
  bodyBytes?: number;
  /** The handler wall-clock duration in ms (latency + the metered compute term), when known. */
  handlerMs?: number;
  /**
   * Present when the call was challenged with a 402 and not auto-paid: the accepts quote
   * the PaywallSheet reads the price from. The `quote` is the escrow accepts entry; its
   * shape mirrors @utter/x402-arc AcceptsEntry (declared `unknown` here to keep the
   * adapter surface free of a direct x402 runtime import).
   */
  paywall?: { quote: unknown };
}

/**
 * The injectable Studio data adapter. Two backends implement it: `fixture` (the
 * deterministic autonomous default, no network/chain/model) and `live` (operator-
 * gated, throws RequiresLiveServicesError for any sub-call needing a provisioned
 * host/funded wallet). The interface is identical so the suite exercises the same
 * contract with no live services (mirrors ResourceProber/Generator).
 */
export interface StudioDataAdapter {
  /** Which backend this adapter is. */
  readonly backend: AdapterBackend;
  /** Compose a resource (STU-01); returns the new id + its SSE events URL. `opts.creator`
   *  is the SIWE wallet that created it - recorded as the owner so the dashboard can scope
   *  its owned-resources view to this creator. */
  createResource(
    spec: ComposeSpec,
    opts?: { creator?: string },
  ): Promise<{ resourceId: string; eventsUrl: string }>;
  /** Stream the build pipeline stages (STU-02) for a resource. The optional signal
   *  lets the SSE route terminate a parked live-channel reader on disconnect or
   *  lifetime expiry (S7); implementations without a parked wait may ignore it. */
  subscribeBuildEvents(
    resourceId: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<BuildEvent>;
  /** Read the resource detail projection (STU-03): card+health+bond+sandbox. */
  getResourceDetail(resourceId: string): Promise<ResourceDetail>;
  /** List marketplace cards (MKT-02) through the filter criteria. */
  listMarketplace(criteria: FilterCriteria): Promise<ResourceCardData[]>;
  /** Aggregate the revenue summary (STU-04) for a resource. */
  getRevenue(resourceId: string): Promise<RevenueSummary>;
  /** Read an address's escrow USDC balance (STU-06) through readUsdcBalance. */
  getEscrowBalance(address: Hex): Promise<UsdcBalance>;
  /** Read an address's ACCRUED escrow balance (PaymentEscrow.balanceOf), the withdrawable
   *  internal balance, distinct from the wallet USDC getEscrowBalance reads. */
  getAccruedEarnings(address: Hex): Promise<UsdcBalance>;
  /**
   * Read a resource's on-chain bond status (StakingVault): posted amount, bond owner, and
   * the cooldown end timestamp (0 = no withdraw requested). The UI derives can-request /
   * can-claim from the connected wallet + the current time.
   */
  getBondStatus(resourceId: Hex): Promise<BondStatusView>;
  /** Run the playground 402 pay-flow (criterion-3 beat) for a resource. */
  runPlayground(resourceId: string, req: unknown): Promise<PlaygroundResult>;
}
