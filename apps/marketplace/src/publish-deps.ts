// publish-deps.ts - the publish pipeline bootstrap for the testnet discovery policy.
//
// createPublishPipelineDeps composes the PublishPipelineDeps the server wires into
// createPublishPipeline. The publish gate is MODERATION (the dependency-free
// KeywordModerator) plus a VERIFICATION PROBE (the existing selectProber seam). The
// on-chain BOND gate and the ERC-8004 MINT are now ENV-GATED SEAMS (live-deps.ts), not
// flat deferrals: they default to the current testnet behavior and arm ONLY under
// explicit operator env, so nothing changes on testnet.
//   - resolveBondGate(env): a pass-through gate + 0n bondReader by default; the real
//     StakingVault floor check + bond reader only when BOND_GATE_ENABLED=1 (testnet has
//     no posted bonds, so auto-arming would reject every publish).
//   - resolveIdentity(env): the deferred PLACEHOLDER (deterministic agentId, NO on-chain
//     mint) by default; the real ERC-8004 update-only mint only when the ERC8004_*
//     registries AND REGISTRY_ADMIN_PRIVATE_KEY are set (operator-gated, undeployed on
//     testnet). The live paths are offline-tested via injected mocks only.
import { KeywordModerator } from "./moderation/classifier.js";
import { ARC_CHAIN_ID } from "@utter/chain";
import { validateAgentCard } from "@utter/ai-runtime";
import { selectProber } from "@utter/ai-scorer";
import { resolveBondGate, resolveIdentity } from "./live-deps.js";
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
  // A structural `mode` marker rides alongside publishIdentity so resolveIdentity's
  // selection (live vs deferred) is assertable in tests WITHOUT minting. The
  // PipelineIdentity type is structural; the extra field is fine, so the literal is
  // built then returned as a PipelineIdentity (publish.ts is unchanged). The live seam
  // carries mode "live"; this one carries "deferred".
  const deferred = {
    mode: "deferred" as const,
    async publishIdentity(resourceId: Hex, _cardUrl: string, card: Record<string, unknown>) {
      // A deterministic, strictly-positive placeholder id from the resourceId. The +1n
      // guarantees agentId > 0 even when the modulus is 0, so it is never a falsy id.
      const agentId = (BigInt(resourceId) % 1_000_000_000n) + 1n;
      const prevIdentity = (card.identity as Record<string, unknown> | undefined) ?? {};
      const finalizedCard: Record<string, unknown> = {
        ...card,
        identity: {
          ...prevIdentity,
          standard: "erc-8004",
          chainId: ARC_CHAIN_ID,
          // The in-card agentId is the STRING form (mirrors the finalized-card shape).
          agentId: agentId.toString(),
        },
      };
      // No on-chain registry tx: the placeholder uses the zero tx hash (deferred mint).
      const registryTxHash = ("0x" + "00".repeat(32)) as Hex;
      return { agentId, registryTxHash, card: finalizedCard };
    },
  };
  return deferred as PipelineIdentity;
}

/**
 * Compose the publish pipeline deps. Moderation runs via the dependency-free
 * KeywordModerator; verification runs via the existing selectProber seam (the always-pass
 * FixtureProber off-host, the LiveHttpsProber only when SCORER_LIVE_HTTPS_HOST is set).
 * The bond gate + bond reader come from resolveBondGate(env) and the identity from
 * resolveIdentity(env): both DEFAULT to the current testnet behavior (pass-through bond +
 * 0n reader; deferred placeholder mint) and arm only under explicit operator env, so the
 * default deps are byte-identical to before.
 *
 * When the operator arms the live prober (SCORER_LIVE_HTTPS_HOST), the injected
 * validateAgentCard makes the publish-time probe validate the served card with the
 * AUTHORITATIVE ajv A2A v0.3.0 validator (the same one the card route and the buyer pay
 * flow use), not just the prober's structural light default. Off-host the always-pass
 * FixtureProber is selected and the validator is unused, so the default deps stay
 * byte-identical to before (selectProber forwards validateCard only to the live prober).
 */
export function createPublishPipelineDeps(
  env: NodeJS.ProcessEnv,
  stores: PublishPipelineStores,
): PublishPipelineDeps {
  const { bondGate, bondReader } = resolveBondGate(env);
  return {
    moderator: new KeywordModerator(),
    moderationStore: stores.moderationStore,
    bondGate,
    bondReader,
    prober: selectProber(env, undefined, { validateCard: validateAgentCard }),
    identity: resolveIdentity(env),
    indexStore: stores.indexStore,
    cardStore: stores.cardStore,
  };
}
