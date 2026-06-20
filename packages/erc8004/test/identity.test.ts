// identity.test.ts - the publish-stores-agentId composition (ID-01/03 wiring). It
// proves, against a MOCKED ERC-8004 client + a mocked ResourceRegistry admin, that
// publishIdentity (1) mints an agentId, (2) writes that SAME numeric agentId as
// bytes32 into ResourceRegistry.agentId, and (3) finalizes card.identity.agentId to
// the same value - and that the finalized card stays validateAgentCard-valid (the
// A2A v0.3.0 flat shape; never supportedInterfaces). The real validateAgentCard is
// used (not a stub) so the card-shape assertion is genuine. T-05-05-IDMISMATCH: the
// agentId written on-chain == the agentId in the card == the minted tokenId.
import { describe, it, expect } from "vitest";
import { numberToHex, type Address, type Hex } from "viem";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import { publishIdentity, type RegistryAdmin } from "../src/identity";
import type { Erc8004Client, RegisterResult } from "../src/client";

const RESOURCE_ID: Hex = `0x${"ab".repeat(32)}`;
const CARD_URL = "https://my-resource.resources.example/.well-known/agent.json";
const REGISTRY_ADDRESS: Address = "0x12aafa5a70c3aD8Bd3a52252744f9F7Aa073E362";

/** A mock ERC-8004 client whose registerAgent returns a fixed minted agentId. */
function makeMockClient(agentId: bigint): {
  client: Erc8004Client;
  calls: { registeredUrl?: string };
} {
  const calls: { registeredUrl?: string } = {};
  const client: Erc8004Client = {
    async registerAgent(cardUrl: string): Promise<RegisterResult> {
      calls.registeredUrl = cardUrl;
      return { agentId, txHash: `0x${"cd".repeat(32)}` as Hex };
    },
    async giveFeedback() {
      return `0x${"00".repeat(32)}` as Hex;
    },
    async validationRequest() {
      return `0x${"00".repeat(32)}` as Hex;
    },
    async validationResponse() {
      return `0x${"00".repeat(32)}` as Hex;
    },
    async readReputation() {
      return 0n;
    },
  };
  return { client, calls };
}

/** A mock ResourceRegistry admin recording the simulate args (the on-chain store). */
function makeMockRegistryAdmin(): {
  admin: RegistryAdmin;
  calls: { simulate: Record<string, unknown>[] };
} {
  const calls: { simulate: Record<string, unknown>[] } = { simulate: [] };
  const ADMIN_ACCT: Hex = "0x00000000000000000000000000000000000000aa";
  const publicClient = {
    async simulateContract(args: Record<string, unknown>) {
      calls.simulate.push(args);
      return { request: { ...args } };
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return { transactionHash: hash, status: "success" as const, logs: [] };
    },
  };
  const walletClient = {
    account: { address: ADMIN_ACCT },
    async writeContract() {
      return `0x${"ef".repeat(32)}` as Hex;
    },
  };
  const admin: RegistryAdmin = {
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    address: REGISTRY_ADDRESS,
  };
  return { admin, calls };
}

describe("publishIdentity", () => {
  it("mints an agentId, writes it as bytes32 into ResourceRegistry, and finalizes the card", async () => {
    const { client, calls: clientCalls } = makeMockClient(42n);
    const { admin, calls: adminCalls } = makeMockRegistryAdmin();
    const card = buildAgentCard({
      prompt: "convert text to speech",
      pricing: { model: "flat", amount: "1000" },
    } as never);

    const result = await publishIdentity(
      { client, registryAdmin: admin },
      RESOURCE_ID,
      CARD_URL,
      card,
    );

    // (1) It minted against the card URL.
    expect(clientCalls.registeredUrl).toBe(CARD_URL);
    expect(result.agentId).toBe(42n);

    // (2) It wrote register(resourceId, ..., agentId-as-bytes32, ...) on the registry.
    expect(adminCalls.simulate).toHaveLength(1);
    const sim = adminCalls.simulate[0] as Record<string, unknown>;
    expect(sim.address).toBe(REGISTRY_ADDRESS);
    expect(sim.functionName).toBe("register");
    const args = sim.args as unknown[];
    // register(resourceId, creator, treasury, creatorBps, agentId, pricingHash)
    expect(args[0]).toBe(RESOURCE_ID);
    const expectedBytes32 = numberToHex(42n, { size: 32 });
    expect(args[4]).toBe(expectedBytes32);

    // (3) The card identity.agentId is finalized to the same numeric agentId.
    const identity = result.card.identity as Record<string, unknown>;
    expect(identity.agentId).toBe("42");
    // The registry store (bytes32) and the card (numeric string) are the same id.
    expect(BigInt(identity.agentId as string)).toBe(42n);
    expect(numberToHex(BigInt(identity.agentId as string), { size: 32 })).toBe(args[4]);
  });

  it("keeps the finalized card validateAgentCard-valid (A2A v0.3.0, no supportedInterfaces)", async () => {
    const { client } = makeMockClient(7n);
    const { admin } = makeMockRegistryAdmin();
    const card = buildAgentCard({
      prompt: "summarize a url",
      pricing: { model: "flat", amount: "500" },
    } as never);

    const result = await publishIdentity(
      { client, registryAdmin: admin },
      RESOURCE_ID,
      CARD_URL,
      card,
    );

    const check = validateAgentCard(result.card);
    expect(check.valid).toBe(true);
    expect(check.errors).toEqual([]);
    // The flat v0.3.0 shape is preserved; no v1.0.0 supportedInterfaces leaked in.
    expect(result.card).not.toHaveProperty("supportedInterfaces");
    expect(result.card.protocolVersion).toBe("0.3.0");
  });

  it("writes via update when mode='update' (re-publish path)", async () => {
    const { client } = makeMockClient(9n);
    const { admin, calls } = makeMockRegistryAdmin();
    const card = buildAgentCard({
      prompt: "translate text",
      pricing: { model: "flat", amount: "200" },
    } as never);

    await publishIdentity(
      { client, registryAdmin: admin, mode: "update" },
      RESOURCE_ID,
      CARD_URL,
      card,
    );

    const sim = calls.simulate[0] as Record<string, unknown>;
    expect(sim.functionName).toBe("update");
    // update(resourceId, treasury, creatorBps, agentId, pricingHash): agentId at idx 3.
    const args = sim.args as unknown[];
    expect(args[3]).toBe(numberToHex(9n, { size: 32 }));
  });

  it("does not mutate the caller's card in place (returns a finalized copy)", async () => {
    const { client } = makeMockClient(3n);
    const { admin } = makeMockRegistryAdmin();
    const card = buildAgentCard({
      prompt: "echo",
      pricing: { model: "flat", amount: "100" },
    } as never);
    const before = (card.identity as Record<string, unknown>).agentId;

    const result = await publishIdentity(
      { client, registryAdmin: admin },
      RESOURCE_ID,
      CARD_URL,
      card,
    );

    // The original card's placeholder is untouched; the returned card is finalized.
    expect((card.identity as Record<string, unknown>).agentId).toBe(before);
    expect((result.card.identity as Record<string, unknown>).agentId).toBe("3");
  });
});
