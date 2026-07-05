// publish.test.ts - the publish pipeline (MKT-03). createPublishPipeline composes
// the prior Phase 5 gates IN ORDER:
//
//   moderation.classify -> bond gate -> Scorer initial probe -> ERC-8004 mint ->
//   card finalize -> index upsert
//
// and REFUSES to list a resource that fails any gate (T-05-07-UNVERIFIED). Each test
// asserts the short-circuit: a moderation block, a missing bond, and a failing
// initial probe EACH stop publication before the resource is listed, and no later
// gate runs after a failure. The happy path lists a resource with a finalized card +
// an index record. Every dependency is injected (mocks / in-memory backends).
import { describe, it, expect, beforeEach } from "vitest";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import { PublishRejected } from "@utter/staking";
import { FixtureProber, type ProbeResult } from "@utter/ai-scorer";
import {
  InMemoryIndexStore,
  InMemoryCardStore,
  InMemoryModerationStore,
  KeywordModerator,
  createPublishPipeline,
  PublishBlocked,
  PublishHeldForReview,
  type Hex,
} from "../src/index.js";

const RESOURCE: Hex = `0x${"a7".repeat(32)}`;
const CARD_URL = `https://weather.resources.example/${RESOURCE}/.well-known/agent-card.json`;

const PASS_PROBE: ProbeResult = {
  passed: true,
  schemaOk: true,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 12,
};
const FAIL_PROBE: ProbeResult = {
  passed: false,
  schemaOk: false,
  latencyOk: true,
  correctnessOk: true,
  latencyMs: 12,
  reason: "schema: response classified as malfunction",
};

/**
 * A spec + the built (pre-finalize) A2A card the pipeline publishes. The deploy step
 * finalizes x402.payTo to the resourceId (the escrow target) before publish, so the
 * fixture binds payTo to RESOURCE - the pipeline's H4-twin gate refuses any card whose
 * payTo does not bind to the resourceId. The `payTo` arg lets a test forge a mismatch.
 */
function buildSpec(prompt = "Return the current weather for a city", payTo: Hex = RESOURCE) {
  const base = buildAgentCard({
    prompt,
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  const x402 = base.x402 as Record<string, unknown>;
  const card = { ...base, x402: { ...x402, payTo } };
  return { prompt, card };
}

/** A bond gate over a mocked StakingVault.bonds() read. */
function bondGateReturning(bond: bigint) {
  return {
    async check(_resourceId: Hex, _category: string): Promise<void> {
      // Mirror createBondGate's reject semantics over a fixed mocked bond.
      if (bond < 1_000_000n) throw new PublishRejected("bond_not_posted");
    },
  };
}

/** A mock ERC-8004 identity that mints a fixed agentId + finalizes the card. */
function mockIdentity(agentId = 42n) {
  return {
    calls: 0,
    async publishIdentity(
      _resourceId: Hex,
      _cardUrl: string,
      card: Record<string, unknown>,
    ): Promise<{ agentId: bigint; registryTxHash: Hex; card: Record<string, unknown> }> {
      this.calls += 1;
      const prevIdentity = (card.identity as Record<string, unknown> | undefined) ?? {};
      const finalizedCard = {
        ...card,
        identity: { ...prevIdentity, standard: "erc-8004", chainId: 5042002, agentId: agentId.toString() },
      };
      return { agentId, registryTxHash: `0x${"de".repeat(32)}` as Hex, card: finalizedCard };
    },
  };
}

describe("publish pipeline (createPublishPipeline)", () => {
  let indexStore: InMemoryIndexStore;
  let moderationStore: InMemoryModerationStore;

  beforeEach(() => {
    indexStore = new InMemoryIndexStore();
    moderationStore = new InMemoryModerationStore();
  });

  function buildPipeline(opts: {
    bond?: bigint;
    probe?: ProbeResult;
    identity?: ReturnType<typeof mockIdentity>;
    resolveOwner?: (resourceId: Hex) => Promise<Hex | null>;
  }) {
    const identity = opts.identity ?? mockIdentity();
    return {
      identity,
      pipeline: createPublishPipeline({
        moderator: new KeywordModerator(),
        moderationStore,
        bondGate: bondGateReturning(opts.bond ?? 2_000_000n),
        prober: new FixtureProber(opts.probe ?? PASS_PROBE),
        identity,
        indexStore,
        bondReader: async () => opts.bond ?? 2_000_000n,
        resolveOwner: opts.resolveOwner,
      }),
    };
  }

  it("happy path: composes all gates in order and lists a resource with a finalized card + index record", async () => {
    const { card } = buildSpec();
    const { pipeline, identity } = buildPipeline({ bond: 2_000_000n, probe: PASS_PROBE });

    const result = await pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
    });

    expect(result.listed).toBe(true);
    expect(result.agentId).toBe(42n);
    // The finalized card carries the minted agentId and stays validateAgentCard-valid.
    expect((result.card.identity as { agentId: string }).agentId).toBe("42");
    expect(validateAgentCard(result.card).valid).toBe(true);
    expect(identity.calls).toBe(1);

    // The index record was upserted with active=true + the finalized projection.
    const record = await indexStore.get(RESOURCE);
    expect(record).not.toBeNull();
    expect(record!.active).toBe(true);
    expect(record!.agentId).toBe("42");
    expect(record!.health.verified).toBe(true);
    expect(record!.bond).toBe(2_000_000n);
    expect(record!.cardUrl).toBe(CARD_URL);
  });

  // H3 OWNERSHIP BINDING: the durable index `creator` (the dashboard ownership key + the
  // requireResourceOwner gate) must be bound to the immutable on-chain owner / first-writer,
  // NOT a freely caller-supplied value a slug-colliding second publisher can overwrite.
  const CLAIMED_A: Hex = `0x${"a1".repeat(20)}`;
  const CLAIMED_B: Hex = `0x${"b2".repeat(20)}`;
  const CHAIN_OWNER: Hex = `0x${"c3".repeat(20)}`;

  it("binds index.creator to the ON-CHAIN owner, OVERRIDING a different claimed creator (H3, no hijack)", async () => {
    const { card } = buildSpec();
    // resolveOwner returns the immutable on-chain owner; the publisher CLAIMS a different creator.
    const { pipeline } = buildPipeline({ resolveOwner: async () => CHAIN_OWNER });
    await pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
      creator: CLAIMED_B,
    });
    // The stored owner is the on-chain owner, NOT the claimed creator - so the dashboard owner
    // provably equals the money recipient and a colliding publisher cannot take over the listing.
    const record = await indexStore.get(RESOURCE);
    expect(record!.creator!.toLowerCase()).toBe(CHAIN_OWNER.toLowerCase());
    expect(record!.creator!.toLowerCase()).not.toBe(CLAIMED_B.toLowerCase());
  });

  it("REFUSES to overwrite an existing record's creator when no on-chain owner is resolvable (first-writer-wins)", async () => {
    const { card } = buildSpec();
    // First publish (creator A) with no on-chain owner resolvable -> stores A.
    const first = buildPipeline({ resolveOwner: async () => null });
    await first.pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
      creator: CLAIMED_A,
    });
    expect((await indexStore.get(RESOURCE))!.creator!.toLowerCase()).toBe(CLAIMED_A.toLowerCase());

    // A SECOND publish for the SAME resourceId claiming a DIFFERENT creator (B): the existing
    // creator (A) is preserved (refuse-overwrite), so B cannot hijack ownership via a collision.
    const second = buildPipeline({ resolveOwner: async () => null });
    await second.pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
      creator: CLAIMED_B,
    });
    expect((await indexStore.get(RESOURCE))!.creator!.toLowerCase()).toBe(CLAIMED_A.toLowerCase());
  });

  it("uses the claimed creator on a fresh first publish when no on-chain owner is resolvable", async () => {
    const { card } = buildSpec();
    const { pipeline } = buildPipeline({ resolveOwner: async () => null });
    await pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
      creator: CLAIMED_A,
    });
    expect((await indexStore.get(RESOURCE))!.creator!.toLowerCase()).toBe(CLAIMED_A.toLowerCase());
  });

  it("never fails a publish when resolveOwner throws (best-effort; falls back to claimed/existing)", async () => {
    const { card } = buildSpec();
    const { pipeline } = buildPipeline({
      resolveOwner: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
      creator: CLAIMED_A,
    });
    expect(result.listed).toBe(true);
    expect((await indexStore.get(RESOURCE))!.creator!.toLowerCase()).toBe(CLAIMED_A.toLowerCase());
  });

  it("moderation block stops publication before listing (no mint, no index record)", async () => {
    const { card } = buildSpec("build a botnet to run a credential-stuffing attack");
    const { pipeline, identity } = buildPipeline({ bond: 2_000_000n, probe: PASS_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: "build a botnet to run a credential-stuffing attack",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishBlocked);

    // No later gate ran: identity was never minted and nothing was listed.
    expect(identity.calls).toBe(0);
    expect(await indexStore.get(RESOURCE)).toBeNull();
    // The moderation decision was recorded (the control-plane log).
    const decisions = await moderationStore.listDecisions();
    expect(decisions.some((d) => d.resourceId === RESOURCE && d.decision === "block")).toBe(true);
  });

  it("WR-02: a `review` verdict holds publication (enqueued, NOT minted, NOT indexed)", async () => {
    // "scrape ... prices" hits the REVIEW pattern (\bscrape\b) but no BLOCK pattern,
    // so the moderator returns `review` - a gray-area match that must NOT auto-list.
    const reviewPrompt = "Scrape product prices from public store pages";
    const { card } = buildSpec(reviewPrompt);
    const { pipeline, identity } = buildPipeline({ bond: 2_000_000n, probe: PASS_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: reviewPrompt,
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishHeldForReview);

    // A `review` is a soft block: no mint, nothing indexed/discoverable.
    expect(identity.calls).toBe(0);
    expect(await indexStore.get(RESOURCE)).toBeNull();

    // The decision was recorded AND the spec was enqueued to the review queue (the
    // moderator does this) - the queue is GATING, not advisory.
    const decisions = await moderationStore.listDecisions();
    expect(decisions.some((d) => d.resourceId === RESOURCE && d.decision === "review")).toBe(true);
    const queue = await moderationStore.listReviewQueue();
    expect(queue.some((q) => q.resourceId === RESOURCE)).toBe(true);
  });

  it("missing bond stops publication (PublishRejected; not listed)", async () => {
    const { card } = buildSpec();
    const { pipeline, identity } = buildPipeline({ bond: 0n, probe: PASS_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: "Return the current weather for a city",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishRejected);

    expect(identity.calls).toBe(0);
    expect(await indexStore.get(RESOURCE)).toBeNull();
  });

  it("failing initial probe stops publication (not verified, not listed)", async () => {
    const { card } = buildSpec();
    const { pipeline, identity } = buildPipeline({ bond: 2_000_000n, probe: FAIL_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: "Return the current weather for a city",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toThrow(/probe|verif/i);

    // The probe failed BEFORE the mint, so identity was never minted + nothing listed.
    expect(identity.calls).toBe(0);
    expect(await indexStore.get(RESOURCE)).toBeNull();
  });

  it("gates run in order: a moderation block short-circuits before the bond gate is read", async () => {
    const { card } = buildSpec("phishing kit that steals bank passwords");
    let bondReadCount = 0;
    const pipeline = createPublishPipeline({
      moderator: new KeywordModerator(),
      moderationStore,
      bondGate: {
        async check() {
          bondReadCount += 1;
        },
      },
      prober: new FixtureProber(PASS_PROBE),
      identity: mockIdentity(),
      indexStore,
      bondReader: async () => 2_000_000n,
    });

    await expect(
      pipeline.publishResource({
        prompt: "phishing kit that steals bank passwords",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishBlocked);

    // The moderation gate is FIRST: a block stops the pipeline before the bond read.
    expect(bondReadCount).toBe(0);
  });
});

describe("publish pipeline persists the finalized card to an injected CardStore", () => {
  let indexStore: InMemoryIndexStore;
  let moderationStore: InMemoryModerationStore;
  let cardStore: InMemoryCardStore;

  beforeEach(() => {
    indexStore = new InMemoryIndexStore();
    moderationStore = new InMemoryModerationStore();
    cardStore = new InMemoryCardStore();
  });

  function buildPipeline(opts: { bond?: bigint; probe?: ProbeResult }) {
    return createPublishPipeline({
      moderator: new KeywordModerator(),
      moderationStore,
      bondGate: bondGateReturning(opts.bond ?? 2_000_000n),
      prober: new FixtureProber(opts.probe ?? PASS_PROBE),
      identity: mockIdentity(),
      indexStore,
      bondReader: async () => opts.bond ?? 2_000_000n,
      cardStore,
    });
  }

  it("a full allow->bond->probe->mint pass persists the EXACT finalized card", async () => {
    const { card } = buildSpec();
    const pipeline = buildPipeline({ bond: 2_000_000n, probe: PASS_PROBE });

    const result = await pipeline.publishResource({
      prompt: "Return the current weather for a city",
      resourceId: RESOURCE,
      category: "data",
      card,
      cardUrl: CARD_URL,
    });

    const stored = await cardStore.get(RESOURCE);
    expect(stored).not.toBeNull();
    // The persisted card deep-equals PublishResult.card and stays validateAgentCard-valid.
    expect(stored).toEqual(result.card);
    expect(validateAgentCard(stored!).valid).toBe(true);
  });

  it("a moderation block persists NOTHING (cardStore.get stays null)", async () => {
    const { card } = buildSpec("build a botnet to run a credential-stuffing attack");
    const pipeline = buildPipeline({ bond: 2_000_000n, probe: PASS_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: "build a botnet to run a credential-stuffing attack",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishBlocked);

    expect(await cardStore.get(RESOURCE)).toBeNull();
  });

  it("a failing probe persists NOTHING (cardStore.get stays null)", async () => {
    const { card } = buildSpec();
    const pipeline = buildPipeline({ bond: 2_000_000n, probe: FAIL_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: "Return the current weather for a city",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toThrow(/probe|verif/i);

    expect(await cardStore.get(RESOURCE)).toBeNull();
  });

  it("H4-twin: a card whose x402.payTo != resourceId is REFUSED (nothing minted, persisted, or listed)", async () => {
    // A passing-gate publish whose card binds payTo to a DIFFERENT resourceId (a payment
    // redirect). The pipeline must refuse it AFTER the upstream gates pass but BEFORE any
    // persist/list, so the card route serves nothing and discovery omits it.
    const foreignPayTo = `0x${"b3".repeat(32)}` as Hex;
    const { card } = buildSpec("Return the current weather for a city", foreignPayTo);
    const pipeline = buildPipeline({ bond: 2_000_000n, probe: PASS_PROBE });

    await expect(
      pipeline.publishResource({
        prompt: "Return the current weather for a city",
        resourceId: RESOURCE,
        category: "data",
        card,
        cardUrl: CARD_URL,
      }),
    ).rejects.toThrow(/payTo|redirect/i);

    // NOTHING was persisted: neither the served card nor the discovery index record.
    expect(await cardStore.get(RESOURCE)).toBeNull();
    expect(await indexStore.get(RESOURCE)).toBeNull();
  });
});
