// publish-deps.ts - the publish pipeline bootstrap for the testnet discovery policy.
//
// createPublishPipelineDeps composes the PublishPipelineDeps the server wires into
// createPublishPipeline. It reflects the chosen testnet policy: the publish gate is
// MODERATION (the dependency-free KeywordModerator) plus a VERIFICATION PROBE (the
// existing selectProber seam). The on-chain BOND gate and the ERC-8004 MINT are
// DEFERRED to the mainnet/compliance track:
//   - bondGate is a pass-through (no on-chain floor check) and bondReader reads 0n,
//     so the index honestly projects an unbonded resource.
//   - identity is a deferred PLACEHOLDER (createDeferredIdentity) that assigns a
//     deterministic agentId WITHOUT minting on-chain.
// The real BondGate + ERC-8004 mint replace these in the mainnet/compliance track.
import { KeywordModerator } from "./moderation/classifier.js";
import { selectProber } from "@utter/ai-scorer";
import type { CardStore } from "./card-store.js";
import type { IndexStore, Hex } from "./index-store.js";
import type { ModerationStore } from "./moderation/review-queue.js";
import type { PublishPipelineDeps, PipelineIdentity } from "./publish.js";

/** The persistent stores the pipeline writes through (all injected so tests compose them). */
export interface PublishPipelineStores {
  /** The marketplace index projection (the LISTING target). */
  indexStore: IndexStore;
  /** The finalized-card serving cache the card route reads. */
  cardStore: CardStore;
  /** The moderation decision log + review queue. */
  moderationStore: ModerationStore;
}

/**
 * Build a DEFERRED placeholder ERC-8004 identity for the testnet discovery policy.
 * It does NOT mint on-chain: publishIdentity assigns a DETERMINISTIC agentId derived
 * from the resourceId and finalizes the card with the standard identity block, so a
 * resource carries a stable placeholder id (and a validateAgentCard-valid card) until
 * the real on-chain mint lands. The real ERC-8004 mint replaces this in the
 * mainnet/compliance track. The returned tuple agentId is a bigint (the pipeline calls
 * minted.agentId.toString()); the in-card identity.agentId is the string form.
 */
export function createDeferredIdentity(): PipelineIdentity {
  return {
    async publishIdentity(resourceId, _cardUrl, card) {
      // A deterministic, strictly-positive placeholder id from the resourceId. The +1n
      // guarantees agentId > 0 even when the modulus is 0, so it is never a falsy id.
      const agentId = (BigInt(resourceId) % 1_000_000_000n) + 1n;
      const prevIdentity = (card.identity as Record<string, unknown> | undefined) ?? {};
      const finalizedCard: Record<string, unknown> = {
        ...card,
        identity: {
          ...prevIdentity,
          standard: "erc-8004",
          chainId: 5042002,
          // The in-card agentId is the STRING form (mirrors the finalized-card shape).
          agentId: agentId.toString(),
        },
      };
      // No on-chain registry tx: the placeholder uses the zero tx hash (deferred mint).
      const registryTxHash = ("0x" + "00".repeat(32)) as Hex;
      return { agentId, registryTxHash, card: finalizedCard };
    },
  };
}

/**
 * Compose the publish pipeline deps for the testnet discovery policy. Moderation runs
 * via the dependency-free KeywordModerator; verification runs via the existing
 * selectProber seam (the always-pass FixtureProber off-host, the LiveHttpsProber only
 * when SCORER_LIVE_HTTPS_HOST is set). The bond gate is a pass-through and bondReader
 * reads 0n (bond deferred); identity is the deferred placeholder (no on-chain mint).
 */
export function createPublishPipelineDeps(
  env: NodeJS.ProcessEnv,
  stores: PublishPipelineStores,
): PublishPipelineDeps {
  return {
    moderator: new KeywordModerator(),
    moderationStore: stores.moderationStore,
    // Bond gate deferred: a pass-through that never rejects on the bond floor.
    bondGate: {
      async check() {},
    },
    // Bond read deferred: honestly project an unbonded resource (0n).
    bondReader: async () => 0n,
    prober: selectProber(env),
    identity: createDeferredIdentity(),
    indexStore: stores.indexStore,
    cardStore: stores.cardStore,
  };
}
