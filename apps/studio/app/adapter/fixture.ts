// fixture.ts - the autonomous test-default StudioDataAdapter.
//
// FixtureAdapter implements every adapter method deterministically from
// app/fixtures (mirroring prober.ts FixtureProber + index-store InMemoryIndexStore):
// NO network, NO chain, NO model. Reads return shallow copies so a caller mutation
// cannot poison the fixture. subscribeBuildEvents is an async generator yielding the
// scripted stages with small awaited gaps, drained-to-completion in tests.
//
// All money is base-unit bigint; there is NO 1e6/10**6/6/18 literal in any amount
// path here.
import { filterResources, type FilterCriteria, type IndexRecord } from "@utter/marketplace";
import { runPlaygroundHarness } from "./playground-harness.js";
import type {
  BuildEvent,
  ComposeSpec,
  Hex,
  PlaygroundResult,
  ResourceCardData,
  ResourceDetail,
  RevenueSummary,
  StudioDataAdapter,
  UsdcBalance,
} from "./types.js";
import {
  FIXTURE_ACCRUED_EARNINGS,
  FIXTURE_BUILD_EVENTS,
  FIXTURE_ESCROW_BALANCE,
  FIXTURE_MARKETPLACE,
  FIXTURE_RESOURCE_DETAIL,
  FIXTURE_RESOURCE_ID,
  FIXTURE_REVENUE,
} from "../fixtures/index.js";

/** A tiny deterministic delay so the SSE generator yields across ticks (no faking). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The deterministic autonomous adapter. Constructed with no arguments; every
 * method projects from the fixture seed. The fixture marketplace list is filtered
 * with the SAME pure filterResources the live index uses, by projecting the card
 * rows into IndexRecord shape for the filter then projecting back.
 */
export class FixtureAdapter implements StudioDataAdapter {
  readonly backend = "fixture" as const;

  async createResource(spec: ComposeSpec): Promise<{ resourceId: string; eventsUrl: string }> {
    // Deterministic: the fixture always composes the canonical fixture resource.
    // The spec is accepted (validated upstream by the action) but not persisted.
    void spec;
    return {
      resourceId: FIXTURE_RESOURCE_ID,
      eventsUrl: `/resources/${FIXTURE_RESOURCE_ID}/events`,
    };
  }

  async *subscribeBuildEvents(_resourceId: string): AsyncIterable<BuildEvent> {
    for (const ev of FIXTURE_BUILD_EVENTS) {
      // Small awaited gap so the stream yields across ticks; deterministic and
      // drained-to-completion in tests (Pitfall 4 - the generator settles).
      await delay(1);
      yield { ...ev };
    }
  }

  async getResourceDetail(_resourceId: string): Promise<ResourceDetail> {
    // Shallow copy on read (InMemoryIndexStore idiom) so callers cannot poison it.
    return { ...FIXTURE_RESOURCE_DETAIL };
  }

  async listMarketplace(criteria: FilterCriteria): Promise<ResourceCardData[]> {
    // Reuse the SAME pure filter the live index uses. Project the fixture cards
    // into IndexRecord shape, filter, then project back to ResourceCardData.
    const records: IndexRecord[] = FIXTURE_MARKETPLACE.map((c) => ({
      resourceId: c.resourceId,
      agentId: c.agentId,
      slug: c.slug,
      category: c.category,
      pricing: { ...c.pricing },
      reputation: c.reputation,
      uptime: c.uptime,
      health: { verified: c.uptime > 0, score: c.uptime },
      bond: c.bond,
      cardUrl: `https://${c.slug}.resources.example.com/.well-known/agent-card.json`,
      active: c.active,
    }));
    const matched = filterResources(records, criteria);
    return matched.map((r) => ({
      resourceId: r.resourceId as Hex,
      agentId: r.agentId,
      slug: r.slug,
      category: r.category,
      pricing: { ...r.pricing },
      reputation: r.reputation,
      uptime: r.uptime,
      bond: r.bond,
      active: r.active,
    }));
  }

  async getRevenue(_resourceId: string): Promise<RevenueSummary> {
    // Shallow copy + per-row copy of the receipts so a caller mutation cannot
    // poison the fixture seed (the InMemoryIndexStore idiom).
    return {
      ...FIXTURE_REVENUE,
      receipts: FIXTURE_REVENUE.receipts.map((r) => ({ ...r })),
    };
  }

  async getEscrowBalance(_address: Hex): Promise<UsdcBalance> {
    return { ...FIXTURE_ESCROW_BALANCE };
  }

  async getAccruedEarnings(_address: Hex): Promise<UsdcBalance> {
    // The accrued internal escrow balance (PaymentEscrow.balanceOf) - a DISTINCT fixture
    // value from FIXTURE_ESCROW_BALANCE so the wallet USDC and the withdrawable earnings
    // render as different amounts. Shallow copy so a caller mutation cannot poison it.
    return { ...FIXTURE_ACCRUED_EARNINGS };
  }

  async runPlayground(resourceId: string, req: unknown): Promise<PlaygroundResult> {
    // The criterion-3 pay-flow beat, proven in LOGIC: reuse the FROZEN Phase-5
    // runTestEndpoint harness VERBATIM (in-process facilitator createApp + mock chain +
    // a debit-counting relayer) - the buyer reads EVERY pay input ONLY from the served
    // agent card, the gate reserves the cap BEFORE the handler runs (reserve-before-run,
    // T-06-FREECOMPUTE), and EXACTLY ONE debit <= cap settles. The cap derives from a
    // RUNTIME decimals() read (no 1e6 literal). The live funded-wallet HTTPS half stays
    // operator-gated and is never invoked here.
    const harness = await runPlaygroundHarness(resourceId, req);
    return {
      paid: harness.result.paid,
      // The single on-chain debit (<= the signed cap), in base units.
      debitAmount: harness.result.debitAmount,
      // The response body the gated handler returned (the buyer's paid result).
      body: harness.result.receipt ?? { ok: harness.result.paid },
    };
  }
}
