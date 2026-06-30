// publish-live-probe.test.ts - the OFFLINE end-to-end publish-gate proof for the live
// HTTPS prober (closing the LiveHttpsProber review gap: no caller injected the
// authoritative card validator, so the live prober only ever used its light default).
//
// Unlike publish.test.ts (which injects a FixtureProber and asserts the gate ORDER),
// this suite drives the REAL LiveHttpsProber through createPublishPipeline with an
// injected fake fetcher + the injected authoritative validateAgentCard + an injected
// clock, so the publish gate's probe makes a real (faked) HTTPS card fetch + an unpaid
// POST /call and validates the served card with the SAME ajv validator the card route
// and the buyer pay flow use. No network, no host, no money: the prober has no wallet,
// never signs, never pays. It proves:
//   1. a verified resource (200 valid card + /call 402) lists;
//   2. a free-serve leak (/call 200) is rejected PublishUnverified and never listed;
//   3. a card the LIGHT default would ACCEPT but the authoritative validator REJECTS is
//      rejected - proving validateAgentCard (not the light default) is wired into the gate;
//   4. an unreachable /call is rejected and never listed.
import { describe, it, expect, beforeEach } from "vitest";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import { LiveHttpsProber, type ProbeFetch } from "@utter/ai-scorer";
import {
  createPublishPipeline,
  PublishUnverified,
  InMemoryIndexStore,
  InMemoryCardStore,
  InMemoryModerationStore,
  KeywordModerator,
  type Hex,
} from "../src/index.js";

const RESOURCE: Hex = `0x${"a7".repeat(32)}`;
const BASE = `https://weather.resources.example/${RESOURCE}`;
const CARD_URL = `${BASE}/.well-known/agent-card.json`;
const CALL_URL = `${BASE}/call`;

// A benign prompt that the KeywordModerator allows (mirrors publish.test.ts happy path),
// so the gate reaches the probe rather than short-circuiting at moderation.
const PROMPT = "Return the current weather for a city";

/**
 * A fake ProbeFetch keyed on CARD_URL (GET 200 + cardBody) and CALL_URL (POST callStatus
 * + {}). Records every call so a test can assert the REAL prober ran (GET card then POST
 * /call). Any other url throws so an unexpected fetch fails the test loudly. A callStatus
 * of `undefined` makes the CALL_URL route throw (the unreachable-endpoint case).
 */
function fakeFetch(callStatus: number | undefined, cardBody: unknown) {
  const calls: Array<{ url: string; init?: Parameters<ProbeFetch>[1] }> = [];
  const fetcher: ProbeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === CARD_URL) return { status: 200, json: async () => cardBody };
    if (url === CALL_URL) {
      if (callStatus === undefined) throw new Error("fake fetch: /call unreachable");
      return { status: callStatus, json: async () => ({}) };
    }
    throw new Error(`fake fetch: unexpected url ${url}`);
  };
  return { fetcher, calls };
}

/** A clock that yields the supplied values in order (default delta well under budget). */
function clockOf(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

/** A pass-through bond gate + a fixed bond reader (mirrors publish.test.ts harness). */
function bondGatePass() {
  return {
    async check(_resourceId: Hex, _category: string): Promise<void> {
      // A bond at/above the floor: the gate passes so the pipeline reaches the probe.
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
        identity: {
          ...prevIdentity,
          standard: "erc-8004",
          chainId: 5042002,
          agentId: agentId.toString(),
        },
      };
      return { agentId, registryTxHash: `0x${"de".repeat(32)}` as Hex, card: finalizedCard };
    },
  };
}

/**
 * A built, validateAgentCard-valid A2A card (the served-card liveness body). The deploy
 * step finalizes x402.payTo to the resourceId before publish, so the fixture binds payTo
 * to RESOURCE; the pipeline's H4-twin gate refuses a card whose payTo does not bind.
 */
function validCardBody(): Record<string, unknown> {
  const base = buildAgentCard({
    prompt: PROMPT,
    runtime: "node",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
  });
  const x402 = base.x402 as Record<string, unknown>;
  return { ...base, x402: { ...x402, payTo: RESOURCE } };
}

describe("publish gate drives the REAL LiveHttpsProber offline (injected fetcher + authoritative validateAgentCard)", () => {
  let indexStore: InMemoryIndexStore;
  let cardStore: InMemoryCardStore;
  let moderationStore: InMemoryModerationStore;

  beforeEach(() => {
    indexStore = new InMemoryIndexStore();
    cardStore = new InMemoryCardStore();
    moderationStore = new InMemoryModerationStore();
  });

  /** Wire createPublishPipeline with the injected live prober + fresh stores. */
  function buildPipeline(prober: LiveHttpsProber) {
    return createPublishPipeline({
      moderator: new KeywordModerator(),
      moderationStore,
      bondGate: bondGatePass(),
      bondReader: async () => 2_000_000n,
      prober,
      identity: mockIdentity(),
      indexStore,
      cardStore,
    });
  }

  it("1. VERIFIED resource lists: 200 valid card + unpaid /call 402 -> listed, card + index persisted", async () => {
    const cardBody = validCardBody();
    const { fetcher, calls } = fakeFetch(402, cardBody);
    const prober = new LiveHttpsProber({
      fetcher,
      validateCard: validateAgentCard,
      now: clockOf([0, 5]),
    });
    const pipeline = buildPipeline(prober);

    const result = await pipeline.publishResource({
      prompt: PROMPT,
      resourceId: RESOURCE,
      category: "data",
      card: cardBody,
      cardUrl: CARD_URL,
    });

    expect(result.listed).toBe(true);
    // The index record + the served card were persisted (the resource is discoverable).
    const record = await indexStore.get(RESOURCE);
    expect(record).not.toBeNull();
    expect(record!.active).toBe(true);
    const stored = await cardStore.get(RESOURCE);
    expect(stored).not.toBeNull();
    expect(validateAgentCard(stored!).valid).toBe(true);

    // The REAL prober ran: GET the card url first, then POST the derived /call url.
    expect(calls[0]).toMatchObject({ url: CARD_URL, init: { method: "GET" } });
    expect(calls[1]).toMatchObject({ url: CALL_URL, init: { method: "POST" } });
  });

  it("2. FREE-SERVE LEAK rejected: valid card but unpaid /call returns 200 -> PublishUnverified, nothing listed", async () => {
    const cardBody = validCardBody();
    const { fetcher } = fakeFetch(200, cardBody); // /call 200 = a free-serve money leak.
    const prober = new LiveHttpsProber({
      fetcher,
      validateCard: validateAgentCard,
      now: clockOf([0, 5]),
    });
    const pipeline = buildPipeline(prober);

    await expect(
      pipeline.publishResource({
        prompt: PROMPT,
        resourceId: RESOURCE,
        category: "data",
        card: cardBody,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishUnverified);

    // Nothing was persisted/listed: the gate short-circuited before the mint + index.
    expect(await indexStore.get(RESOURCE)).toBeNull();
    expect(await cardStore.get(RESOURCE)).toBeNull();
  });

  it("3. INVALID CARD rejected by the AUTHORITATIVE validator: a card the LIGHT default ACCEPTS but ajv REJECTS -> PublishUnverified, nothing listed", async () => {
    // The chosen field is `capabilities`: it IS in A2A_V030_CARD_SCHEMA.required[]
    // (agent-card.ts) so the authoritative validateAgentCard REJECTS a card without it,
    // but lightValidateCard (prober.ts) only checks protocolVersion + non-empty skills +
    // x402{scheme,asset,escrow}, so it ACCEPTS this card. Removing `capabilities` (while
    // keeping protocolVersion "0.3.0", skills, and x402{scheme:utter-escrow,asset,escrow})
    // therefore passes the light default but fails the strict schema - proving the gate
    // runs the authoritative validator, not the prober's light default. (Other required[]
    // fields the light check omits - version, defaultInputModes, defaultOutputModes - would
    // serve equally; `capabilities` is used here.)
    const cardBody = validCardBody();
    delete (cardBody as Record<string, unknown>).capabilities;
    // Sanity: the light default would accept this (so a passing gate would have to be the
    // authoritative validator failing it). We assert the authoritative validator rejects it.
    expect(validateAgentCard(cardBody).valid).toBe(false);

    const { fetcher } = fakeFetch(402, cardBody); // /call would gate correctly; the card fails first.
    const prober = new LiveHttpsProber({
      fetcher,
      validateCard: validateAgentCard,
      now: clockOf([0, 5]),
    });
    const pipeline = buildPipeline(prober);

    await expect(
      pipeline.publishResource({
        prompt: PROMPT,
        resourceId: RESOURCE,
        category: "data",
        card: cardBody,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishUnverified);

    expect(await indexStore.get(RESOURCE)).toBeNull();
    expect(await cardStore.get(RESOURCE)).toBeNull();
  });

  it("4. UNREACHABLE endpoint rejected: /call throws -> probe fails -> PublishUnverified, nothing listed", async () => {
    const cardBody = validCardBody();
    const { fetcher } = fakeFetch(undefined, cardBody); // CALL_URL route throws.
    const prober = new LiveHttpsProber({
      fetcher,
      validateCard: validateAgentCard,
      now: clockOf([0, 5]),
    });
    const pipeline = buildPipeline(prober);

    await expect(
      pipeline.publishResource({
        prompt: PROMPT,
        resourceId: RESOURCE,
        category: "data",
        card: cardBody,
        cardUrl: CARD_URL,
      }),
    ).rejects.toBeInstanceOf(PublishUnverified);

    expect(await indexStore.get(RESOURCE)).toBeNull();
    expect(await cardStore.get(RESOURCE)).toBeNull();
  });
});
