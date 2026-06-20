// client.test.ts - the ERC-8004 viem client proved against a MOCKED viem client
// (no network). The autonomous proof is encode-correctness (the simulate/write/read
// calls carry the right address + abi + functionName + args) plus decode-of-a-mock
// receipt (registerAgent pulls the minted tokenId out of the Registered log). The
// live broadcast is operator-gated; these tests never touch a chain.
import { describe, it, expect } from "vitest";
import { encodeEventTopics, encodeAbiParameters, type Hex } from "viem";
import { identityAbi } from "@utter/chain";
import {
  createErc8004Client,
  HEALTH_VALUE_DECIMALS,
  type Erc8004Addresses,
} from "../src/client";

// The (unpinned, operator-gated) reference registry addresses the test injects.
const ADDRESSES: Erc8004Addresses = {
  identity: "0x1111111111111111111111111111111111111111",
  reputation: "0x2222222222222222222222222222222222222222",
  validation: "0x3333333333333333333333333333333333333333",
};

const ADMIN: Hex = "0x00000000000000000000000000000000000000aa";

/** Records every simulate/write/read/wait call so the test can assert the encode. */
interface Recorded {
  simulate: unknown[];
  write: unknown[];
  read: unknown[];
  waited: Hex[];
}

/**
 * Build a mocked publicClient + walletClient pair. `registeredAgentId` is the
 * tokenId the mock Registered log carries so registerAgent can decode it. Each
 * write returns a deterministic fake tx hash; the receipt for that hash carries
 * the canned logs.
 */
function makeMockClients(registeredAgentId: bigint, feedbackCount = 0n) {
  const rec: Recorded = { simulate: [], write: [], read: [], waited: [] };

  // A canned Registered log built from the REAL identityAbi so the client's
  // decodeEventLog round-trips byte-for-byte (this is the genuine decode proof).
  // Registered(uint256 indexed agentId, string agentURI, address indexed owner):
  // the indexed agentId+owner go in the topics, the non-indexed agentURI in data.
  const registeredTopics = encodeEventTopics({
    abi: identityAbi,
    eventName: "Registered",
    args: { agentId: registeredAgentId, owner: ADMIN },
  });
  const registeredData = encodeAbiParameters(
    [{ name: "agentURI", type: "string" }],
    ["https://card.example/agent.json"],
  );
  const registeredLog = { topics: registeredTopics, data: registeredData };

  const TX_HASH: Hex = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";

  const publicClient = {
    async simulateContract(args: Record<string, unknown>) {
      rec.simulate.push(args);
      // viem returns { request } that the wallet then writes verbatim.
      return { request: { ...args }, result: undefined };
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      rec.waited.push(hash);
      return {
        transactionHash: hash,
        status: "success" as const,
        logs: [
          {
            address: ADDRESSES.identity,
            data: registeredLog.data,
            topics: registeredLog.topics,
          },
        ],
      };
    },
    async readContract(args: Record<string, unknown>) {
      rec.read.push(args);
      // feedbackCount(agentId) read for readReputation.
      return feedbackCount;
    },
  };

  const walletClient = {
    account: { address: ADMIN },
    async writeContract(request: Record<string, unknown>) {
      rec.write.push(request);
      return TX_HASH;
    },
  };

  return { publicClient, walletClient, rec, TX_HASH };
}

describe("createErc8004Client", () => {
  it("registerAgent simulates register(agentURI), writes, waits, and decodes the tokenId as agentId", async () => {
    const { publicClient, walletClient, rec, TX_HASH } = makeMockClients(42n);
    const client = createErc8004Client({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: ADDRESSES,
    });

    const result = await client.registerAgent("https://card.example/agent.json");

    // Decoded the minted tokenId from the Registered log.
    expect(result.agentId).toBe(42n);
    expect(result.txHash).toBe(TX_HASH);

    // Encode proof: simulate carried the identity address + register + the card URL.
    expect(rec.simulate).toHaveLength(1);
    const sim = rec.simulate[0] as Record<string, unknown>;
    expect(sim.address).toBe(ADDRESSES.identity);
    expect(sim.functionName).toBe("register");
    expect(sim.args).toEqual(["https://card.example/agent.json"]);
    expect(sim.abi).toBe(identityAbi);
    // The admin account was passed for the simulate (gated write origin).
    expect((sim.account as { address: Hex }).address).toBe(ADMIN);

    // It wrote the simulated request and waited on the returned hash.
    expect(rec.write).toHaveLength(1);
    expect(rec.waited).toEqual([TX_HASH]);
  });

  it("registerAgent throws when no Registered log is present (no silent zero agentId)", async () => {
    const { publicClient, walletClient } = makeMockClients(7n);
    // Override the receipt to carry no decodable Registered log.
    publicClient.waitForTransactionReceipt = async ({ hash }: { hash: Hex }) => ({
      transactionHash: hash,
      status: "success" as const,
      logs: [],
    });
    const client = createErc8004Client({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: ADDRESSES,
    });
    await expect(
      client.registerAgent("https://card.example/agent.json"),
    ).rejects.toThrow(/Registered/i);
  });

  it("giveFeedback encodes value = round(score * 10^HEALTH_VALUE_DECIMALS) with tag1=health", async () => {
    const { publicClient, walletClient, rec } = makeMockClients(1n);
    const client = createErc8004Client({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: ADDRESSES,
    });

    await client.giveFeedback(99n, 0.75, "search");

    expect(rec.simulate).toHaveLength(1);
    const sim = rec.simulate[0] as Record<string, unknown>;
    expect(sim.address).toBe(ADDRESSES.reputation);
    expect(sim.functionName).toBe("giveFeedback");
    const args = sim.args as unknown[];
    // agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash
    expect(args[0]).toBe(99n);
    // value = round(0.75 * 10^4) = 7500 as int128 (bigint).
    expect(args[1]).toBe(BigInt(Math.round(0.75 * 10 ** HEALTH_VALUE_DECIMALS)));
    expect(args[2]).toBe(HEALTH_VALUE_DECIMALS);
    expect(args[3]).toBe("health");
    expect(args[4]).toBe("search");
  });

  it("giveFeedback clamps the score into [0,1] before encoding (no out-of-range value)", async () => {
    const { publicClient, walletClient, rec } = makeMockClients(1n);
    const client = createErc8004Client({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: ADDRESSES,
    });

    await client.giveFeedback(1n, 1.5, "x");
    await client.giveFeedback(1n, -0.2, "x");

    const a = (rec.simulate[0] as Record<string, unknown>).args as unknown[];
    const b = (rec.simulate[1] as Record<string, unknown>).args as unknown[];
    expect(a[1]).toBe(BigInt(10 ** HEALTH_VALUE_DECIMALS)); // clamped to 1.0
    expect(b[1]).toBe(0n); // clamped to 0.0
  });

  it("validationRequest and validationResponse encode against the validation address", async () => {
    const { publicClient, walletClient, rec } = makeMockClients(1n);
    const client = createErc8004Client({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: ADDRESSES,
    });

    const validator: Hex = "0x00000000000000000000000000000000000000bb";
    const reqHash: Hex = `0x${"11".repeat(32)}`;
    await client.validationRequest(validator, 5n, "https://req.example", reqHash);

    const req = rec.simulate[0] as Record<string, unknown>;
    expect(req.address).toBe(ADDRESSES.validation);
    expect(req.functionName).toBe("validationRequest");
    expect(req.args).toEqual([validator, 5n, "https://req.example", reqHash]);

    await client.validationResponse(reqHash, 1, "https://res.example", reqHash, "ok");
    const res = rec.simulate[1] as Record<string, unknown>;
    expect(res.address).toBe(ADDRESSES.validation);
    expect(res.functionName).toBe("validationResponse");
    expect(res.args).toEqual([reqHash, 1, "https://res.example", reqHash, "ok"]);
  });

  it("readReputation reads feedbackCount(agentId) for the marketplace resolve", async () => {
    const { publicClient, walletClient, rec } = makeMockClients(1n, 3n);
    const client = createErc8004Client({
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      addresses: ADDRESSES,
    });

    const count = await client.readReputation(77n);
    expect(count).toBe(3n);

    expect(rec.read).toHaveLength(1);
    const read = rec.read[0] as Record<string, unknown>;
    expect(read.address).toBe(ADDRESSES.reputation);
    expect(read.functionName).toBe("feedbackCount");
    expect(read.args).toEqual([77n]);
  });
});

describe("resolveErc8004Addresses", () => {
  it("reads the reference registry addresses from env (no hardcoded phantom 0x8004)", async () => {
    const { resolveErc8004Addresses } = await import("../src/client");
    const env = {
      ERC8004_IDENTITY_REGISTRY: ADDRESSES.identity,
      ERC8004_REPUTATION_REGISTRY: ADDRESSES.reputation,
      ERC8004_VALIDATION_REGISTRY: ADDRESSES.validation,
    };
    expect(resolveErc8004Addresses(env)).toEqual(ADDRESSES);
  });

  it("throws when an address is unset (operator has not deployed/pinned yet)", async () => {
    const { resolveErc8004Addresses } = await import("../src/client");
    expect(() => resolveErc8004Addresses({})).toThrow(/ERC8004_/);
  });
});
