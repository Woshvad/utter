// publish.ts - the publish pipeline (MKT-03), the integrating wave that closes the
// trust loop. createPublishPipeline composes EVERY prior Phase 5 gate IN ORDER and
// REFUSES to list a resource that fails any gate (T-05-07-UNVERIFIED):
//
//   1. moderation.classify  (Plan 06) - a `block` stops here; the decision is recorded.
//   2. bond gate            (Plan 04) - StakingVault.bonds() below the floor -> PublishRejected.
//   3. Scorer initial probe (Plan 03) - a failing pre-list probe -> PublishUnverified.
//   4. ERC-8004 mint        (Plan 05) - publishIdentity mints the agentId + finalizes the card.
//   5. card finalize        (from the mint) - health{verified,score} from the probe,
//                                             bond{posted,amount} from the bond read.
//   6. index upsert         (Plan 06) - the read-through projection record, active=true.
//
// Each gate SHORT-CIRCUITS: an unmoderated / unbonded / unverified resource is NEVER
// listed. No later gate runs after a failure (the moderation block never reads the
// bond, a missing bond never mints, a failing probe never mints). Every dependency is
// INJECTED so the test composes the gates with mocks / in-memory backends - this
// module owns the ORDER + the short-circuit, never re-implementing the gates.
//
// This composes the EXISTING functions from 05-03..05-06; it does not re-author them.
import { validateAgentCard } from "@utter/ai-runtime";
import type { Moderator } from "./moderation/classifier.js";
import type { ModerationStore } from "./moderation/review-queue.js";
import type { IndexStore, IndexRecord, ProjectedPricing, Hex } from "./index-store.js";
import type { CardStore } from "./card-store.js";

/** The Scorer's initial pre-list probe (Plan 03 ProbeResult shape, structurally typed). */
export interface InitialProbeResult {
  /** True iff schema + latency + correctness all held - the verification gate input. */
  passed: boolean;
  /** The rolling 0..1 health score from the probe (null when unscored). */
  latencyMs?: number;
  /** A short, non-secret reason the probe failed (absent when passed). */
  reason?: string;
}

/**
 * The minimal prober surface the pipeline drives for the initial verification probe
 * (Plan 03 ResourceProber.probe). Structurally satisfied by FixtureProber +
 * LiveHttpsProber so the autonomous proof injects a FixtureProber.
 */
export interface PipelineProber {
  probe(target: { resourceId: string; url?: string }): Promise<InitialProbeResult>;
}

/**
 * The bond gate surface (Plan 04 BondGate.check). Resolves when the on-chain bond
 * satisfies the floor + the category minimum; throws PublishRejected otherwise. The
 * pipeline never re-implements the floor math - it calls the existing gate.
 */
export interface PipelineBondGate {
  check(resourceId: Hex, category: string): Promise<void>;
}

/**
 * The ERC-8004 identity surface (Plan 05 publishIdentity). Mints the agentId once and
 * returns the finalized, validateAgentCard-valid card with identity.agentId set. The
 * pipeline calls it AFTER moderation + bond + probe pass (never mints a rejected resource).
 */
export interface PipelineIdentity {
  publishIdentity(
    resourceId: Hex,
    cardUrl: string,
    card: Record<string, unknown>,
  ): Promise<{ agentId: bigint; registryTxHash: Hex; card: Record<string, unknown> }>;
}

/**
 * Read the projected bond amount for the index record (the read-through projection
 * value, StakingVault.bonds()). The bond GATE only decides pass/fail; this reader
 * supplies the numeric bond the index projects. Returns 0n for an unbonded resource.
 */
export type BondReader = (resourceId: Hex) => Promise<bigint>;

/** Everything the publish pipeline composes (all injected for the mock-backed proof). */
export interface PublishPipelineDeps {
  /** The moderation gate (Plan 06) - classify + record + enqueue. Runs FIRST. */
  moderator: Moderator;
  /** The moderation decision log + review queue the moderator writes to. */
  moderationStore: ModerationStore;
  /** The bond gate (Plan 04) - rejects publication below the on-chain floor. */
  bondGate: PipelineBondGate;
  /** The Scorer prober (Plan 03) - the initial pre-list verification probe. */
  prober: PipelineProber;
  /** The ERC-8004 identity (Plan 05) - mints the agentId + finalizes the card. */
  identity: PipelineIdentity;
  /** The marketplace index (Plan 06) - the read-through projection upsert. */
  indexStore: IndexStore;
  /** Reads the projected bond amount for the index record (defaults to 0n if absent). */
  bondReader?: BondReader;
  /**
   * The finalized-card serving cache. When present, the LISTING step persists the EXACT
   * finalized card the card route serves. Optional so existing callers/tests that only
   * exercise the index projection compose the pipeline unchanged.
   */
  cardStore?: CardStore;
}

/** The publish request: the spec + the (pre-finalize) built card + its served URL. */
export interface PublishRequest {
  /** The creator's plain-English prompt (the moderation input). */
  prompt: string;
  /** The on-chain resourceId (bytes32). */
  resourceId: Hex;
  /** The listing category (data / compute / ...). */
  category: string;
  /** The built A2A card (pre-finalize; the mint sets identity.agentId). */
  card: Record<string, unknown>;
  /** The absolute URL the resource's /.well-known/agent-card.json is served at. */
  cardUrl: string;
  /** An optional discovery slug override (defaults to the card name). */
  slug?: string;
  /** An optional initial reputation projection (feedbackCount; defaults to 0n). */
  reputation?: bigint;
}

/** The publish result on success: the minted agentId, the finalized card, the record. */
export interface PublishResult {
  /** Whether the resource was listed (always true on a resolved publishResource). */
  listed: boolean;
  /** The minted ERC-8004 agentId. */
  agentId: bigint;
  /** The finalized, validateAgentCard-valid card (identity.agentId set). */
  card: Record<string, unknown>;
  /** The index record that was upserted (active=true). */
  record: IndexRecord;
}

/** Publication was blocked by moderation (prohibited use). The resource is NOT listed. */
export class PublishBlocked extends Error {
  /** The moderation reason (a stable machine-ish code from the classifier). */
  readonly reason: string;
  constructor(reason: string) {
    super(`publish blocked by moderation: ${reason}`);
    this.name = "PublishBlocked";
    this.reason = reason;
  }
}

/**
 * Publication is HELD pending human review (WR-02). A `review` moderation verdict is a
 * gray-area match (an ambiguous prohibited-use pattern), so the resource is enqueued to
 * the moderation review queue but is NOT bonded/probed/minted/indexed - it is not
 * payable or discoverable until a moderator explicitly clears it to `allow`. This makes
 * the review queue GATING, not advisory: a `review` is a soft block, never an auto-list.
 */
export class PublishHeldForReview extends Error {
  /** The moderation reason that routed this spec to review. */
  readonly reason: string;
  constructor(reason: string) {
    super(`publish held for human review: ${reason}`);
    this.name = "PublishHeldForReview";
    this.reason = reason;
  }
}

/**
 * Publication was refused because the initial verification probe failed. The resource
 * is NOT verified and therefore NOT listed (T-05-07-UNVERIFIED).
 */
export class PublishUnverified extends Error {
  /** The probe failure reason (a short, non-secret dimension reason). */
  readonly reason: string;
  constructor(reason: string) {
    super(`publish refused: initial probe failed verification: ${reason}`);
    this.name = "PublishUnverified";
    this.reason = reason;
  }
}

/** Case-insensitive bytes32 equality (a resourceId/payTo is not case-significant). */
function eqHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The composed publish pipeline. */
export interface PublishPipeline {
  /**
   * Run the publish gates IN ORDER and list the resource only if every gate passes.
   * Resolves with the finalized card + the upserted index record on success; rejects
   * with PublishBlocked / PublishRejected / PublishUnverified (short-circuited) on a
   * gate failure WITHOUT listing the resource.
   */
  publishResource(req: PublishRequest): Promise<PublishResult>;
}

/** Read the pricing block off the (built) card x402 for the index projection. */
function projectPricing(card: Record<string, unknown>): ProjectedPricing {
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const pricing = (x402.pricing as Record<string, unknown> | undefined) ?? {};
  return {
    model: typeof pricing.model === "string" ? pricing.model : "metered",
    base: typeof pricing.base === "string" ? pricing.base : "0",
    perKB: typeof pricing.perKB === "string" ? pricing.perKB : "0",
    // The escrow cap projection: the metered max if present, else the base.
    max: typeof pricing.max === "string" ? pricing.max : (typeof pricing.base === "string" ? pricing.base : "0"),
  };
}

/** Read the discovery slug off the built card (the A2A `name`), or fall back. */
function cardSlug(card: Record<string, unknown>): string {
  return typeof card.name === "string" && card.name.length > 0 ? card.name : "resource";
}

/**
 * Build the publish pipeline over the injected gates. `publishResource` composes the
 * gates IN ORDER and short-circuits on any failure; an unmoderated / unbonded /
 * unverified resource is NEVER listed.
 */
export function createPublishPipeline(deps: PublishPipelineDeps): PublishPipeline {
  const bondReader: BondReader = deps.bondReader ?? (async () => 0n);

  return {
    async publishResource(req) {
      const { resourceId, category, cardUrl } = req;

      // (1) MODERATION - the FIRST gate. A `block` stops publication here, and a
      // gray-area `review` HOLDS it pending human review (WR-02); the decision is
      // recorded and (for `review`) the spec is enqueued by the moderator. ONLY an
      // explicit `allow` proceeds down bond -> probe -> mint -> index. The resource is
      // never bonded/probed/minted/listed on a `block` OR a `review`.
      const decision = await deps.moderator.moderate(
        { prompt: req.prompt, category, resourceId },
        deps.moderationStore,
      );
      if (decision.decision === "block") {
        throw new PublishBlocked(decision.reason);
      }
      if (decision.decision === "review") {
        // The moderator already enqueued the review-queue item; hold publication until
        // a moderator resolves it to `allow`. Not minted, not indexed, not discoverable.
        throw new PublishHeldForReview(decision.reason);
      }

      // (2) BOND GATE - reads StakingVault.bonds() and rejects publication below the
      // floor / category minimum (Plan 04). A missing bond throws PublishRejected,
      // short-circuiting BEFORE the probe + the mint.
      await deps.bondGate.check(resourceId, category);

      // (3) INITIAL PROBE - the Scorer's pre-list verification (SCR-01). A failing
      // probe means the endpoint is not verified, so it is NEVER listed.
      const probe = await deps.prober.probe({ resourceId, url: cardUrl });
      if (!probe.passed) {
        throw new PublishUnverified(probe.reason ?? "initial probe did not pass");
      }

      // (4) MINT - ERC-8004 publishIdentity mints the agentId once and finalizes the
      // card (identity.agentId set; validateAgentCard re-run inside publishIdentity).
      // Only reached after moderation + bond + probe all pass.
      const minted = await deps.identity.publishIdentity(resourceId, cardUrl, req.card);

      // (5) CARD FINALIZE - project health{verified,score} from the probe and
      // bond{posted,amount} from the bond read onto the minted card so the served card
      // carries the live verification + bond state (the marketplace serves THIS card).
      const bondAmount = await bondReader(resourceId);
      // health.score stays null at publish: the pre-list probe is a pass/fail
      // verification gate, not a rolling 0..1 score (that is populated by the Scorer
      // schedule post-list). `verified:true` records that the initial probe passed.
      const finalizedCard: Record<string, unknown> = {
        ...minted.card,
        health: { verified: true, score: null },
        bond: { posted: bondAmount > 0n, amount: bondAmount.toString() },
      };

      // IN-04: re-validate the FINALIZED card (after health/bond are spread on) before
      // it is served/indexed. publishIdentity validated the minted card, but the
      // health/bond projection happens AFTER that, so the served card is validated at
      // the point it is finalized - not only later at serve time (a future card-schema
      // tightening would otherwise pass publish and fail at the route with a 500).
      const finalizedCheck = validateAgentCard(finalizedCard);
      if (!finalizedCheck.valid) {
        throw new Error(
          `publish: finalized card failed validateAgentCard: ${finalizedCheck.errors.join("; ")}`,
        );
      }

      // (5a) PAYTO BINDING (H4-twin) - the served card's x402.payTo is the escrow target
      // a buyer signs its DebitAuthorization over. validateAgentCard only shape-checks
      // payTo, so a card whose x402.payTo points at a DIFFERENT resourceId would otherwise
      // be minted, persisted, and listed - letting a publisher redirect every payment for
      // this resource to another resource's escrow. Bind payTo to the resourceId here
      // (case-insensitive bytes32 compare) BEFORE any persist/list; a mismatch is refused
      // so a mismatched card is never minted-as-served, persisted, or discoverable. The
      // gate ORDER (moderation -> bond -> probe -> mint) and every short-circuit above are
      // unchanged; this only guards the LISTING step.
      const finalX402 = (finalizedCard.x402 as Record<string, unknown> | undefined) ?? {};
      const finalPayTo = finalX402.payTo;
      if (typeof finalPayTo !== "string" || !eqHex(finalPayTo, resourceId)) {
        throw new PublishUnverified(
          `card x402.payTo does not bind to the resourceId (payment redirect refused)`,
        );
      }

      // (6) INDEX UPSERT - the read-through projection record, active=true. The store
      // mirrors the card x402 pricing + the projected bond/reputation; it authors none
      // of them (T-05-06-INDEXTRUST). This is the LISTING step.
      const record: IndexRecord = {
        resourceId,
        agentId: minted.agentId.toString(),
        slug: req.slug ?? cardSlug(finalizedCard),
        category,
        pricing: projectPricing(finalizedCard),
        reputation: req.reputation ?? 0n,
        uptime: 1,
        health: { verified: true, score: null },
        bond: bondAmount,
        cardUrl,
        active: true,
      };
      // Persist the EXACT finalizedCard the card route must serve. This is part of the
      // LISTING step, reached ONLY after moderation + bond + probe + mint all pass, so a
      // blocked / held / unbonded / unverified resource persists no card. Optional: when
      // no cardStore is injected the pipeline lists via the index projection alone.
      if (deps.cardStore) await deps.cardStore.put(resourceId, finalizedCard);
      await deps.indexStore.upsert(record);

      return { listed: true, agentId: minted.agentId, card: finalizedCard, record };
    },
  };
}
