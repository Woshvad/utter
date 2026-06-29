// fixtures/index.ts - deterministic fixture data for the FixtureAdapter.
//
// This is the autonomous test default seed (mirroring prober.ts ALWAYS_PASS +
// index-store records). Everything here is constructed in-process: NO network,
// NO chain, NO model. All money is token BASE UNITS (bigint) - there is NO
// 1e6/10**6/6/18 literal anywhere in this file's amount paths.
import type {
  BuildEvent,
  ResourceCardData,
  ResourceDetail,
  RevenueSummary,
  UsdcBalance,
} from "../adapter/types.js";
// RevenueReceipt is referenced structurally in FIXTURE_REVENUE.receipts (typed via
// RevenueSummary); no separate runtime import needed.

/** The deterministic fixture resourceId every fixture read keys off. */
export const FIXTURE_RESOURCE_ID =
  "0x00000000000000000000000000000000000000000000000000000000000000a1" as const;

/** The deterministic fixture creator/owner address (checksummed). */
export const FIXTURE_CREATOR = "0x1111111111111111111111111111111111111111" as const;

/** A second listed resource so the marketplace fixture has more than one card. */
export const FIXTURE_RESOURCE_ID_2 =
  "0x00000000000000000000000000000000000000000000000000000000000000b2" as const;

/**
 * The scripted build-event stream the FixtureAdapter replays for STU-02. One
 * "running" then "ok" pair per stage, in order, ending with Live -> ok. Draining
 * this to completion in a test asserts the six stages and termination.
 */
export const FIXTURE_BUILD_EVENTS: readonly BuildEvent[] = [
  { stage: "Generate", status: "running", log: "generating handler bundle" },
  { stage: "Generate", status: "ok", log: "bundle generated" },
  { stage: "Deploy", status: "running", log: "deploying to sandbox" },
  { stage: "Deploy", status: "ok", log: "sandbox up" },
  { stage: "Verify", status: "running", log: "probing schema + latency + correctness" },
  { stage: "Verify", status: "ok", log: "verification passed" },
  { stage: "Mint", status: "running", log: "minting ERC-8004 identity" },
  { stage: "Mint", status: "ok", log: "agentId minted" },
  { stage: "Publish", status: "running", log: "publishing agent card + index" },
  { stage: "Publish", status: "ok", log: "listed for discovery" },
  { stage: "Live", status: "ok", log: "resource is live" },
] as const;

/** The deterministic resource-detail projection (creator + card+health+bond+sandbox). */
export const FIXTURE_RESOURCE_DETAIL: ResourceDetail = {
  resourceId: FIXTURE_RESOURCE_ID,
  creator: FIXTURE_CREATOR,
  agentId: "42",
  slug: "weather-now",
  category: "data",
  payout: FIXTURE_CREATOR,
  pricing: {
    model: "flat",
    // Base units (string). No decimals literal: these are raw on-chain amounts.
    base: "10000",
    perKB: "0",
    max: "10000",
  },
  health: { verified: true, score: 0.98 },
  bond: 5000000n,
  sandbox: "live",
  cardUrl: "https://weather-now.resources.example.com/.well-known/agent-card.json",
};

/** The marketplace card list (MKT-02 fixture rows). */
export const FIXTURE_MARKETPLACE: readonly ResourceCardData[] = [
  {
    resourceId: FIXTURE_RESOURCE_ID,
    agentId: "42",
    slug: "weather-now",
    category: "data",
    pricing: { model: "flat", base: "10000", perKB: "0", max: "10000" },
    reputation: 12n,
    uptime: 0.98,
    bond: 5000000n,
    active: true,
  },
  {
    resourceId: FIXTURE_RESOURCE_ID_2,
    agentId: "43",
    slug: "summarize-text",
    category: "compute",
    pricing: { model: "metered", base: "2000", perKB: "500", max: "50000" },
    reputation: 7n,
    uptime: 0.95,
    bond: 8000000n,
    active: true,
  },
] as const;

/**
 * The revenue summary fixture (STU-04). All money base-unit bigint. The settle
 * receipts sum to `gross` and the refund receipt sums to `refunds`; the
 * creator/platform split is the projected aggregate (not recomputed at render).
 * Each receipt carries a deterministic fixture tx hash for the ArcScan TxLinks -
 * these are CLEARLY-fixture values (a1..-suffixed), never faked live numbers.
 */
export const FIXTURE_REVENUE: RevenueSummary = {
  resourceId: FIXTURE_RESOURCE_ID,
  calls: 128,
  gross: 1280000n,
  creatorShare: 896000n,
  platformShare: 384000n,
  refunds: 20000n,
  receipts: [
    {
      tx: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a101",
      kind: "settle",
      amount: 800000n,
      idemKey: "idem-settle-1",
    },
    {
      tx: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a102",
      kind: "settle",
      amount: 480000n,
      idemKey: "idem-settle-2",
    },
    {
      tx: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a103",
      kind: "refund",
      amount: 20000n,
      idemKey: "idem-refund-1",
    },
  ],
};

/** The escrow balance fixture (STU-06). Raw base units + runtime-style decimals. */
export const FIXTURE_ESCROW_BALANCE: UsdcBalance = {
  raw: 25000000n,
  decimals: 6,
};

/**
 * The ACCRUED earnings fixture (STU-06 / payout): the creator's withdrawable internal
 * escrow balance (PaymentEscrow.balanceOf), DISTINCT from FIXTURE_ESCROW_BALANCE so the
 * wallet USDC and the accrued earnings read as visibly different amounts. Raw base units
 * (a base-unit constant) + runtime-style decimals, the same way the escrow fixture carries
 * its decimals - no decimals literal is applied in any amount math.
 */
export const FIXTURE_ACCRUED_EARNINGS: UsdcBalance = {
  raw: 12_340_000n,
  decimals: 6,
};
