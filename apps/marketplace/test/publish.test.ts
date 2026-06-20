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
  InMemoryModerationStore,
  KeywordModerator,
  createPublishPipeline,
  PublishBlocked,
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

/** A spec + the built (pre-finalize) A2A card the pipeline publishes. */
function buildSpec(prompt = "Return the current weather for a city") {
  const card = buildAgentCard({
    prompt,
    pricing: { model: "metered", base: "5000", perKB: "100", computeMultiplier: "200" },
  });
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
