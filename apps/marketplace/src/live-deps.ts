// live-deps.ts - the env-gated LIVE seams for the publish pipeline bond gate + the
// ERC-8004 identity mint. createPublishPipelineDeps (publish-deps.ts) wires these in,
// and BOTH default to the current testnet behavior so nothing changes on testnet:
//   - resolveBondGate(env) is a pass-through (bondReader 0n) UNLESS BOND_GATE_ENABLED=1.
//   - resolveIdentity(env) is the deferred placeholder (no on-chain mint) UNLESS all of
//     the ERC8004_* registries AND REGISTRY_ADMIN_PRIVATE_KEY are set.
//
// The LIVE paths are OPERATOR-GATED and NEVER run in tests or on testnet: the ERC-8004
// reference registries are unpinned / undeployed on Arc Testnet and there is no funded
// REGISTRY_ADMIN key, so the env conditions are never met there. The live paths are
// offline-tested ONLY by injecting mock clients through the `overrides` param (mirroring
// the @utter/erc8004 + @utter/staking mock idioms); no real chain, no broadcast, no key
// read happens under test. Constructing the live clients is LAZY (no network); only an
// actual publishIdentity / bondGate.check call would touch the chain.
//
// SPLIT-CLOBBER invariant (cross-service ordering): the deployer
// (services/deployer/src/register-resource.ts) registers the resource on the
// ResourceRegistry FIRST, with a placeholder agentId (the zero word). The marketplace
// mint here runs LATER and only UPDATES that record to set the minted agentId. So the
// live mint uses mode "update" (mode "register" would revert AlreadyRegistered on an
// already-registered id) and reads the existing on-chain split via getResource to
// preserve creator/treasury/creatorBps, changing ONLY the agentId. It never passes a
// zero split (that would clobber the real split the deployer recorded).
//
// NOTE on getResource's shape: ResourceRegistry.getResource returns ONLY
// (creator, treasury, creatorBps, active) - it does NOT return the pricingHash. The
// pricingHash is an advisory indexer field the escrow debit never reads, and the
// deployer registers it as the zero word, so the update mirrors that zero word. The
// money-routing split (creator/treasury/creatorBps) IS recovered and preserved.
import {
  createArcPublicClient,
  createArcWalletClient,
  RESOURCE_REGISTRY,
  STAKING_VAULT,
  registryAbi,
  stakingVaultAbi,
} from "@utter/chain";
import {
  publishIdentity,
  createErc8004Client,
  resolveErc8004Addresses,
  type RegistryAdmin,
} from "@utter/erc8004";
import { createBondGate } from "@utter/staking";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { Erc8004Client } from "@utter/erc8004";
import { createDeferredIdentity } from "./publish-deps.js";
import type { PipelineIdentity, PipelineBondGate, BondReader } from "./publish.js";

/** A 32-byte zero word: the pricingHash the deployer records and the update mirrors. */
const ZERO32: Hex = `0x${"00".repeat(32)}`;

/**
 * The injected live parts for the identity seam's offline test. When present,
 * resolveIdentity skips the env build entirely and uses these mocks - so the live mint
 * is provable with NO real chain, NO key read, and NO broadcast.
 */
export interface IdentityLiveParts {
  /** The ERC-8004 mint client (mocked in tests; the Arc-bound client in prod). */
  client: Erc8004Client;
  /** The ResourceRegistry admin writer (mocked in tests; the Arc admin in prod). */
  registryAdmin: RegistryAdmin;
}

/** Optional overrides for resolveIdentity (the offline test seam). */
export interface ResolveIdentityOverrides {
  /** Inject the live parts to exercise the live mint path without a real chain. */
  liveParts?: IdentityLiveParts;
}

/** Optional overrides for resolveBondGate (the offline test seam). */
export interface ResolveBondGateOverrides {
  /** Inject a read-path client so the real gate is provable without a real chain. */
  publicClient?: Parameters<typeof createBondGate>[0]["publicClient"];
}

/**
 * Build the LIVE PipelineIdentity from the injected mint client + registry admin. It
 * mints the agentId and UPDATES the existing on-chain ResourceRegistry record without
 * clobbering the split:
 *   1. Read the existing resource via getResource to recover the on-chain split
 *      (creator / treasury / creatorBps). The deployer registered it first.
 *   2. Call the canonical publishIdentity in mode "update" with that read-back split, so
 *      only the agentId changes (the SPLIT-CLOBBER guard). pricingHash mirrors the
 *      deployer's zero word (getResource does not return it; it is advisory).
 * The canonical publishIdentity owns the card finalization + validateAgentCard - this
 * never re-authors it. The `mode: "live"` marker lets tests assert the live selection.
 */
function buildLiveIdentity(parts: IdentityLiveParts): PipelineIdentity {
  const { client, registryAdmin } = parts;
  return {
    mode: "live",
    async publishIdentity(resourceId, cardUrl, card) {
      // (1) Read the existing on-chain split the deployer registered FIRST. getResource
      // returns (creator, treasury, creatorBps, active); we preserve the split fields.
      const existing = (await registryAdmin.publicClient.readContract({
        address: RESOURCE_REGISTRY,
        abi: registryAbi,
        functionName: "getResource",
        args: [resourceId],
      } as never)) as readonly [Address, Address, number, boolean];
      const [creator, treasury, creatorBps] = existing;

      // (2) Update-only mint: set the minted agentId while preserving the read-back
      // split. mode "update" (never "register": that would revert AlreadyRegistered).
      return publishIdentity(
        {
          client,
          registryAdmin,
          mode: "update",
          resource: { creator, treasury, creatorBps, pricingHash: ZERO32 },
        },
        resourceId,
        cardUrl,
        card,
      );
    },
  } as PipelineIdentity;
}

/**
 * Resolve the publish pipeline's ERC-8004 identity seam.
 *
 * Selection (in order):
 *   1. overrides.liveParts present -> the LIVE mint over the injected mocks (the offline
 *      test seam; no env build, no real chain).
 *   2. ALL of ERC8004_IDENTITY_REGISTRY / ERC8004_REPUTATION_REGISTRY /
 *      ERC8004_VALIDATION_REGISTRY / REGISTRY_ADMIN_PRIVATE_KEY set -> the LIVE mint over
 *      Arc-bound clients (operator-gated). Building the clients is lazy (no network).
 *   3. NODE_ENV=production AND IDENTITY_MINT_REQUIRED=1 (but registries/key unconfigured)
 *      -> THROW a value-free error (prod insists on a real mint; fail-closed). The key
 *      is NEVER logged or echoed.
 *   4. ELSE -> the deferred placeholder (the current testnet default; no on-chain mint).
 */
export function resolveIdentity(
  env: NodeJS.ProcessEnv,
  overrides?: ResolveIdentityOverrides,
): PipelineIdentity {
  // (1) Offline test seam: live mint over injected mocks, no env build.
  if (overrides?.liveParts) {
    return buildLiveIdentity(overrides.liveParts);
  }

  // (2) Live arming: all three registries AND the admin key must be set. RESOURCE_REGISTRY
  // is pinned in @utter/chain; the reference registries come from resolveErc8004Addresses.
  const haveRegistries =
    !!env.ERC8004_IDENTITY_REGISTRY &&
    !!env.ERC8004_REPUTATION_REGISTRY &&
    !!env.ERC8004_VALIDATION_REGISTRY;
  const haveAdminKey = !!env.REGISTRY_ADMIN_PRIVATE_KEY;

  if (haveRegistries && haveAdminKey) {
    // Build the Arc-bound clients lazily (no network until an actual call). The admin
    // account is derived from the operator-gated key; it is never logged.
    const publicClient = createArcPublicClient(env.ARC_RPC_URL);
    const adminAccount = privateKeyToAccount(env.REGISTRY_ADMIN_PRIVATE_KEY as Hex);
    const walletClient = createArcWalletClient(adminAccount, env.ARC_RPC_URL);
    const client = createErc8004Client({
      publicClient,
      walletClient,
      addresses: resolveErc8004Addresses(env),
    });
    const registryAdmin: RegistryAdmin = {
      publicClient,
      walletClient,
      address: RESOURCE_REGISTRY,
    };
    return buildLiveIdentity({ client, registryAdmin });
  }

  // (3) Prod fail-closed: production demands a real mint but it is unconfigured. Throw a
  // value-free error so a misconfig never silently lists with a placeholder. No key value.
  if (env.NODE_ENV === "production" && env.IDENTITY_MINT_REQUIRED === "1") {
    throw new Error(
      "resolveIdentity: IDENTITY_MINT_REQUIRED=1 in production but the ERC-8004 registries " +
        "and/or REGISTRY_ADMIN key are unconfigured - the live mint is operator-gated and " +
        "must be set before listing (fail-closed; the placeholder mint is not allowed in prod)",
    );
  }

  // (4) Default: the deferred placeholder (testnet unchanged; no on-chain mint).
  return createDeferredIdentity();
}

/**
 * Resolve the publish pipeline's bond gate + bond reader seam.
 *
 * ARMED ONLY when BOND_GATE_ENABLED === "1". On testnet NO resource has posted a bond, so
 * StakingVault.bonds is 0n for all; auto-arming the real gate would reject EVERY publish
 * with bond_not_posted. Arming is therefore an explicit operator opt-in once bonds exist.
 *
 *   - ARMED: the real createBondGate (floor check) over the Arc public client (or an
 *     injected mock via overrides), plus a bondReader that reads StakingVault.bonds for
 *     the index projection.
 *   - UNARMED (default): a pass-through gate (never rejects) + a 0n bondReader, byte-
 *     identical to the current testnet behavior.
 */
export function resolveBondGate(
  env: NodeJS.ProcessEnv,
  overrides?: ResolveBondGateOverrides,
): { bondGate: PipelineBondGate; bondReader: BondReader } {
  if (env.BOND_GATE_ENABLED === "1") {
    const publicClient = overrides?.publicClient ?? createArcPublicClient(env.ARC_RPC_URL);
    const bondGate = createBondGate({ publicClient });
    const bondReader: BondReader = async (resourceId) =>
      (await publicClient.readContract({
        address: STAKING_VAULT,
        abi: stakingVaultAbi,
        functionName: "bonds",
        args: [resourceId],
      })) as bigint;
    return { bondGate, bondReader };
  }

  // Default (unarmed): pass-through gate + 0n reader (byte-identical to today).
  return {
    bondGate: { async check() {} },
    bondReader: async () => 0n,
  };
}
