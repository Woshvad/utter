// client.ts - the ERC-8004 registry viem client (ID-01/02). It wraps the three
// reference registries (Identity / Reputation / Validation) whose ABIs land in
// @utter/chain from Plan 02. The client is written over a SINGLE pinned viem
// (2.52.2) - no second copy - and takes INJECTABLE public/wallet clients (mirrors
// services/facilitator RelayerPoolOptions) so the autonomous tests prove the
// encode/decode against a mock with no network.
//
// The live broadcast (register mint + reputation/validation writes on Arc) is
// OPERATOR-GATED: there is no funded REGISTRY_ADMIN key in the repo and the three
// reference registry addresses are UNPINNED in @utter/chain until the operator runs
// the Plan 02 CREATE2 deploy. So the addresses are RESOLVED FROM ENV (ERC8004_*),
// never a hardcoded phantom 0x8004... (T-05-05-PHANTOM).
//
// register(agentURI) -> agentId: the IdentityRegistry is an ERC-721 whose minted
// tokenId IS the agentId (05-RESEARCH resolution). registerAgent simulates ->
// writes -> waits -> decodes the Registered log to return the numeric tokenId.
//
// Reputation encoding (05-RESEARCH Open Q2, A3): the Scorer's rolling 0..1 health
// score maps to giveFeedback's (int128 value, uint8 valueDecimals) via the FIXED
// encoding value = round(clamp(score,0,1) * 10^HEALTH_VALUE_DECIMALS), tag1="health",
// tag2=category. This `value` is a feedback SCALE, never a USDC amount - so no money
// decimals literal appears (the 10^4 here scales a 0..1 score, not a token amount).
import {
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { identityAbi, reputationAbi, validationAbi } from "@utter/chain";

/**
 * The fixed feedback scale for the health score: value = round(score * 10^4), so a
 * 0..1 score encodes as 0..10000 in the int128 `value` with valueDecimals=4. This is
 * a reputation SCALE (documented, fixed), NOT a USDC amount - no money decimals here.
 */
export const HEALTH_VALUE_DECIMALS = 4;

/** The (operator-gated, unpinned) reference registry addresses. */
export interface Erc8004Addresses {
  /** IdentityRegistry (ERC-721 register(agentURI)->agentId). */
  identity: Address;
  /** ReputationRegistry (giveFeedback / feedbackCount). */
  reputation: Address;
  /** ValidationRegistry (validationRequest / validationResponse). */
  validation: Address;
}

/**
 * Injectables for createErc8004Client (mirrors RelayerPoolOptions). Tests inject a
 * mocked public/wallet client; the live path injects the @utter/chain Arc clients.
 */
export interface Erc8004ClientOptions {
  /** Read + simulate + receipt-wait surface (a viem PublicClient or a mock). */
  publicClient: PublicClient;
  /** Write surface carrying the (operator-gated) admin account. */
  walletClient: WalletClient;
  /** The reference registry addresses (from resolveErc8004Addresses(env)). */
  addresses: Erc8004Addresses;
}

/** The result of a register mint: the minted agentId (tokenId) + the broadcast tx. */
export interface RegisterResult {
  /** The minted ERC-721 tokenId, which IS the agentId (numeric, 1-indexed). */
  agentId: bigint;
  /** The register broadcast transaction hash. */
  txHash: Hex;
}

/** The ERC-8004 client surface the publish pipeline + scorer call. */
export interface Erc8004Client {
  /**
   * Mint the agent identity: simulate register(agentURI) -> write -> wait -> decode
   * the Registered log -> return the minted tokenId as the agentId. The broadcast is
   * operator-gated (the injected wallet must hold a funded admin account on Arc).
   */
  registerAgent(cardUrl: string): Promise<RegisterResult>;
  /**
   * Write the Scorer's health score for an agent: encodes value = round(clamp(score)
   * * 10^HEALTH_VALUE_DECIMALS), tag1="health", tag2=category. Operator-gated write.
   */
  giveFeedback(agentId: bigint, score: number, category: string): Promise<Hex>;
  /** Record a validation request (call-stats / attestation request). Gated write. */
  validationRequest(
    validator: Address,
    agentId: bigint,
    requestURI: string,
    requestHash: Hex,
  ): Promise<Hex>;
  /** Answer a validation request (only the addressed validator on-chain). Gated write. */
  validationResponse(
    requestHash: Hex,
    response: number,
    responseURI: string,
    responseHash: Hex,
    tag: string,
  ): Promise<Hex>;
  /** Read the agent's feedback count for the marketplace reputation resolve. */
  readReputation(agentId: bigint): Promise<bigint>;
}

/**
 * Resolve the three reference registry addresses from the environment (ERC8004_*).
 * The addresses stay UNPINNED in @utter/chain until the operator runs the Plan 02
 * CREATE2 deploy, so they are read from `.env.local` here - NEVER a hardcoded phantom
 * 0x8004... address (T-05-05-PHANTOM). Throws if any is unset so a mis-config fails
 * loudly rather than minting into nowhere.
 */
export function resolveErc8004Addresses(
  env: Record<string, string | undefined> = process.env,
): Erc8004Addresses {
  const identity = env.ERC8004_IDENTITY_REGISTRY;
  const reputation = env.ERC8004_REPUTATION_REGISTRY;
  const validation = env.ERC8004_VALIDATION_REGISTRY;
  const missing: string[] = [];
  if (!identity) missing.push("ERC8004_IDENTITY_REGISTRY");
  if (!reputation) missing.push("ERC8004_REPUTATION_REGISTRY");
  if (!validation) missing.push("ERC8004_VALIDATION_REGISTRY");
  if (missing.length > 0) {
    throw new Error(
      `resolveErc8004Addresses: unset ${missing.join(", ")} - the ERC-8004 reference ` +
        "registries are operator-gated; set them in .env.local after the CREATE2 deploy",
    );
  }
  return {
    identity: identity as Address,
    reputation: reputation as Address,
    validation: validation as Address,
  };
}

/** Clamp a score into [0,1] so the encoded int128 value never goes out of range. */
function clampScore(score: number): number {
  if (Number.isNaN(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/**
 * Build the ERC-8004 client over the injected viem clients + reference addresses.
 * The write methods run simulate -> write -> wait (the standard viem gated write
 * path); the autonomous tests inject a mock that records the encode and returns a
 * canned receipt. The live broadcast is operator-gated.
 */
export function createErc8004Client(options: Erc8004ClientOptions): Erc8004Client {
  const { publicClient, walletClient, addresses } = options;
  const account = walletClient.account;

  // simulate -> write -> wait for the receipt: the shared gated write idiom. Returns
  // the receipt so the caller can decode an event (register decodes the tokenId).
  async function simulateWriteWait(
    address: Address,
    abi: typeof identityAbi | typeof reputationAbi | typeof validationAbi,
    functionName: string,
    args: readonly unknown[],
  ) {
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account,
    } as never);
    const hash = await walletClient.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, receipt };
  }

  return {
    async registerAgent(cardUrl: string): Promise<RegisterResult> {
      const { hash, receipt } = await simulateWriteWait(
        addresses.identity,
        identityAbi,
        "register",
        [cardUrl],
      );
      // Decode the Registered log to pull the minted tokenId as the agentId. We try
      // each log against the identityAbi and take the first Registered event from the
      // identity registry; a missing event is a hard error (never a silent 0 agentId).
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== addresses.identity.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: identityAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "Registered") {
            const agentId = (decoded.args as { agentId: bigint }).agentId;
            return { agentId, txHash: hash };
          }
        } catch {
          // Not the Registered event; keep scanning.
        }
      }
      throw new Error(
        `registerAgent: no Registered event in the register tx ${hash} - the mint did not emit an agentId`,
      );
    },

    async giveFeedback(agentId: bigint, score: number, category: string): Promise<Hex> {
      // value = round(clamp(score,0,1) * 10^HEALTH_VALUE_DECIMALS) as an int128 (bigint).
      // This scales a 0..1 reputation score, NOT a token amount (no money decimals).
      const value = BigInt(Math.round(clampScore(score) * 10 ** HEALTH_VALUE_DECIMALS));
      const { hash } = await simulateWriteWait(
        addresses.reputation,
        reputationAbi,
        "giveFeedback",
        [
          agentId,
          value,
          HEALTH_VALUE_DECIMALS,
          "health", // tag1: the metric kind
          category, // tag2: the resource category
          "", // endpoint (off-chain card URL carries the detail)
          "", // feedbackURI
          `0x${"00".repeat(32)}` as Hex, // feedbackHash (none for an on-chain score)
        ],
      );
      return hash;
    },

    async validationRequest(
      validator: Address,
      agentId: bigint,
      requestURI: string,
      requestHash: Hex,
    ): Promise<Hex> {
      const { hash } = await simulateWriteWait(
        addresses.validation,
        validationAbi,
        "validationRequest",
        [validator, agentId, requestURI, requestHash],
      );
      return hash;
    },

    async validationResponse(
      requestHash: Hex,
      response: number,
      responseURI: string,
      responseHash: Hex,
      tag: string,
    ): Promise<Hex> {
      const { hash } = await simulateWriteWait(
        addresses.validation,
        validationAbi,
        "validationResponse",
        [requestHash, response, responseURI, responseHash, tag],
      );
      return hash;
    },

    async readReputation(agentId: bigint): Promise<bigint> {
      const count = await publicClient.readContract({
        address: addresses.reputation,
        abi: reputationAbi,
        functionName: "feedbackCount",
        args: [agentId],
      } as never);
      return count as bigint;
    },
  };
}
