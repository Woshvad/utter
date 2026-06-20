// identity.ts - the publish-stores-agentId composition (ID-01/03 wiring). On
// publish, the SAME numeric agentId minted by the IdentityRegistry MUST land in two
// canonical places that have to agree (T-05-05-IDMISMATCH):
//
//   1. ResourceRegistry.agentId (as bytes32) - the ON-CHAIN canonical store the
//      escrow/marketplace read for the resource. (contracts/src/ResourceRegistry.sol
//      register/update take a `bytes32 agentId`.)
//   2. card.identity.agentId - the A2A agent card's ERC-8004 identity block that the
//      marketplace serves and other agents read.
//
// publishIdentity mints once (client.registerAgent) and finalizes both from that one
// tokenId, so they can never diverge. The numeric agentId is encoded to bytes32 via
// viem numberToHex(size:32) for the on-chain store, and serialized as a decimal
// string into the JSON card. The finalized card MUST stay validateAgentCard-valid
// (A2A v0.3.0 flat shape; never emit supportedInterfaces - Pitfall 4).
//
// No new on-chain identity is invented: the ERC-8004 standard identity (the tokenId)
// mirrors into the registry store + card. The live mint + registry write are
// operator-gated; the autonomous proof injects a mock client + admin and runs the
// REAL validateAgentCard.
import { numberToHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { registryAbi } from "@utter/chain";
import { validateAgentCard } from "@utter/ai-runtime";
import type { Erc8004Client } from "./client.js";

/** Zero values used for the optional register config when the caller omits it. */
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/**
 * The ResourceRegistry admin writer (the on-chain canonical agentId store). Mirrors
 * the client's injectable shape so tests mock it: an injected public/wallet client
 * pair plus the registry address. The wallet carries the (operator-gated) admin
 * account that owns the registry.
 */
export interface RegistryAdmin {
  /** Read + simulate + receipt-wait surface (a viem PublicClient or a mock). */
  publicClient: PublicClient;
  /** Write surface carrying the registry-owner admin account (operator-gated). */
  walletClient: WalletClient;
  /** The ResourceRegistry address (from @utter/chain RESOURCE_REGISTRY). */
  address: Address;
}

/**
 * The resource split config the registry register/update needs alongside the agentId.
 * Optional for the autonomous mint proof; the real publish pipeline (Plan 07) passes
 * the creator/treasury/bps/pricingHash from the resource record. Amounts are not
 * money here - creatorBps is a basis-point split, pricingHash is a commitment hash;
 * no USDC decimals literal appears.
 */
export interface ResourceConfig {
  /** The resource creator (paid the majority of every call). */
  creator?: Address;
  /** The treasury that takes the platform cut. */
  treasury?: Address;
  /** The creator split in basis points (0..10000). */
  creatorBps?: number;
  /** The pricing commitment hash (bytes32). */
  pricingHash?: Hex;
}

/** The publishIdentity options: the mint client + the on-chain registry writer. */
export interface PublishIdentityOptions {
  /** The ERC-8004 client that mints the agentId (Task 1). */
  client: Erc8004Client;
  /** The ResourceRegistry admin that stores the agentId on-chain. */
  registryAdmin: RegistryAdmin;
  /** "register" (first publish, default) or "update" (re-publish an existing resource). */
  mode?: "register" | "update";
  /** The resource split config for the registry write (optional for the mint proof). */
  resource?: ResourceConfig;
}

/** The publishIdentity result: the minted agentId + the finalized agent card. */
export interface PublishIdentityResult {
  /** The minted ERC-721 tokenId (the agentId), the single source of truth. */
  agentId: bigint;
  /** The register/update broadcast tx hash on the ResourceRegistry. */
  registryTxHash: Hex;
  /** The agent card with identity.agentId finalized (validateAgentCard-valid). */
  card: Record<string, unknown>;
}

/**
 * Mint the agent identity and finalize it into BOTH the on-chain ResourceRegistry
 * and the agent card, from a single tokenId so the two can never diverge.
 *
 * Steps: (1) client.registerAgent(cardUrl) mints the agentId; (2) write that agentId
 * (as bytes32) into ResourceRegistry.agentId via register or update on the injected
 * admin client; (3) return the card with identity.agentId finalized to the same value.
 * The returned card stays validateAgentCard-valid (throws if it would not).
 *
 * @throws if the finalized card fails validateAgentCard (the publish must not serve an
 *   invalid card).
 */
export async function publishIdentity(
  options: PublishIdentityOptions,
  resourceId: Hex,
  cardUrl: string,
  card: Record<string, unknown>,
): Promise<PublishIdentityResult> {
  const { client, registryAdmin, mode = "register", resource = {} } = options;

  // (1) Mint the agentId (the ERC-721 tokenId) - the single source of truth.
  const { agentId } = await client.registerAgent(cardUrl);
  const agentIdBytes32 = numberToHex(agentId, { size: 32 });

  // (2) Store the SAME agentId (as bytes32) in the ResourceRegistry on-chain canonical
  // store via register or update. The split config comes from the resource record (or
  // zero defaults for the autonomous mint proof). Operator-gated broadcast.
  const creatorBps = resource.creatorBps ?? 0;
  const pricingHash = resource.pricingHash ?? ZERO_BYTES32;
  const treasury = resource.treasury ?? ZERO_ADDRESS;

  const args =
    mode === "register"
      ? [
          resourceId,
          resource.creator ?? ZERO_ADDRESS,
          treasury,
          creatorBps,
          agentIdBytes32,
          pricingHash,
        ]
      : [resourceId, treasury, creatorBps, agentIdBytes32, pricingHash];

  const { request } = await registryAdmin.publicClient.simulateContract({
    address: registryAdmin.address,
    abi: registryAbi,
    functionName: mode,
    args,
    account: registryAdmin.walletClient.account,
  } as never);
  const registryTxHash = await registryAdmin.walletClient.writeContract(request as never);
  await registryAdmin.publicClient.waitForTransactionReceipt({ hash: registryTxHash });

  // (3) Finalize card.identity.agentId to the SAME numeric agentId (decimal string for
  // JSON). Work on a shallow copy + a fresh identity object so the caller's card is not
  // mutated in place. The ERC-8004 standard identity mirrors the registry store.
  const prevIdentity = (card.identity as Record<string, unknown> | undefined) ?? {};
  const finalizedCard: Record<string, unknown> = {
    ...card,
    identity: {
      ...prevIdentity,
      standard: "erc-8004",
      chainId: 5042002,
      agentId: agentId.toString(),
    },
  };

  // The finalized card MUST stay validateAgentCard-valid (v0.3.0 flat shape; never
  // supportedInterfaces). A publish that would serve an invalid card is a hard error.
  const check = validateAgentCard(finalizedCard);
  if (!check.valid) {
    throw new Error(
      `publishIdentity: finalized card failed validateAgentCard: ${check.errors.join("; ")}`,
    );
  }

  return { agentId, registryTxHash, card: finalizedCard };
}
