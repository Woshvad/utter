// publish-deps.test.ts - the env-gated LIVE seams (live-deps.ts) that lift the two
// Track A deferrals (the ERC-8004 mint + the on-chain bond gate). It proves, against
// MOCK clients only (no real chain, no key, no broadcast):
//   - DEFAULT (no new env) is byte-identical to before: deferred placeholder identity +
//     pass-through bond gate + 0n bondReader.
//   - The LIVE identity path (armed via injected mocks) mints + UPDATES the on-chain
//     record while PRESERVING the read-back split (the SPLIT-CLOBBER guard).
//   - The prod fail-closed throw (IDENTITY_MINT_REQUIRED=1 in prod, unconfigured).
//   - The LIVE bond gate (armed via BOND_GATE_ENABLED=1 + an injected mock client)
//     enforces the real floor and the bondReader reads the on-chain bond.
// The real validateAgentCard runs inside publishIdentity, so the card-shape assertions
// are genuine. The live paths NEVER touch Arc here - they are driven entirely by mocks.
import { describe, it, expect, vi } from "vitest";
import { numberToHex, type Address, type Hex } from "viem";
import { buildAgentCard, validateAgentCard } from "@utter/ai-runtime";
import { RESOURCE_REGISTRY, STAKING_VAULT, registryAbi, stakingVaultAbi } from "@utter/chain";
import { MIN_BOND_BASE_UNITS, PublishRejected } from "@utter/staking";
import type { RegistryAdmin, Erc8004Client, RegisterResult } from "@utter/erc8004";
import { resolveIdentity, resolveBondGate, type IdentityLiveParts } from "../src/live-deps.js";

const RESOURCE_ID: Hex = `0x${"ab".repeat(32)}`;
const CARD_URL = "https://my-resource.resources.example/.well-known/agent-card.json";

// A non-zero on-chain split the deployer registered FIRST; the mint must preserve it.
const EXISTING_CREATOR: Address = "0x1111111111111111111111111111111111111111";
const EXISTING_TREASURY: Address = "0x2222222222222222222222222222222222222222";
const EXISTING_BPS = 7000;

/** A mock ERC-8004 client whose registerAgent returns a fixed minted agentId. */
function makeMockClient(agentId: bigint): Erc8004Client {
  return {
    async registerAgent(): Promise<RegisterResult> {
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
}

/**
 * A mock ResourceRegistry admin. getResource (readContract) returns the existing
 * non-zero split; simulateContract records the update args so the SPLIT-CLOBBER guard
 * is assertable; writeContract returns a canned tx hash.
 */
function makeMockRegistryAdmin(): {
  admin: RegistryAdmin;
  spies: { readContract: ReturnType<typeof vi.fn>; simulateContract: ReturnType<typeof vi.fn> };
} {
  const readContract = vi.fn(async (_args: unknown) => [
    EXISTING_CREATOR,
    EXISTING_TREASURY,
    EXISTING_BPS,
    true,
  ] as const);
  const simulateContract = vi.fn(async (args: Record<string, unknown>) => ({ request: { ...args } }));
  const publicClient = {
    readContract,
    simulateContract,
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return { transactionHash: hash, status: "success" as const, logs: [] };
    },
  };
  const walletClient = {
    account: { address: "0x00000000000000000000000000000000000000aa" as Address },
    async writeContract() {
      return `0x${"ef".repeat(32)}` as Hex;
    },
  };
  return {
    admin: {
      publicClient: publicClient as never,
      walletClient: walletClient as never,
      address: RESOURCE_REGISTRY,
    },
    spies: { readContract, simulateContract },
  };
}

/** Build a fresh pre-finalize card for each case. */
function freshCard(): Record<string, unknown> {
  return buildAgentCard({
    prompt: "convert text to speech",
    pricing: { model: "flat", amount: "1000" },
  } as never);
}

describe("resolveIdentity (env-gated ERC-8004 mint seam)", () => {
  it("DEFAULT (no env) selects the deferred placeholder (no on-chain mint)", async () => {
    const identity = resolveIdentity({} as NodeJS.ProcessEnv);
    expect((identity as { mode?: string }).mode).toBe("deferred");

    const result = await identity.publishIdentity(RESOURCE_ID, CARD_URL, freshCard());
    // The placeholder uses the zero tx hash (deferred mint) + a deterministic agentId.
    expect(result.registryTxHash).toBe(`0x${"00".repeat(32)}`);
    expect(result.agentId > 0n).toBe(true);
    const check = validateAgentCard(result.card);
    expect(check.valid).toBe(true);
  });

  it("LIVE (injected mocks) mints + UPDATES preserving the read-back split (SPLIT-CLOBBER guard)", async () => {
    const { admin, spies } = makeMockRegistryAdmin();
    const liveParts: IdentityLiveParts = { client: makeMockClient(42n), registryAdmin: admin };
    const identity = resolveIdentity({} as NodeJS.ProcessEnv, { liveParts });
    expect((identity as { mode?: string }).mode).toBe("live");

    const result = await identity.publishIdentity(RESOURCE_ID, CARD_URL, freshCard());

    // It read the existing on-chain resource via getResource to recover the split.
    expect(spies.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: RESOURCE_REGISTRY,
        abi: registryAbi,
        functionName: "getResource",
        args: [RESOURCE_ID],
      }),
    );

    // The minted agentId is finalized into the card.
    expect(result.agentId).toBe(42n);
    const identityBlock = result.card.identity as Record<string, unknown>;
    expect(identityBlock.agentId).toBe("42");
    expect(validateAgentCard(result.card).valid).toBe(true);

    // SPLIT-CLOBBER guard: the update is mode "update" and carries the READ-BACK split
    // (treasury/creatorBps from getResource) plus only the minted agentId changed.
    // update(resourceId, treasury, creatorBps, agentId, pricingHash).
    expect(spies.simulateContract).toHaveBeenCalledTimes(1);
    const firstCall = spies.simulateContract.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sim = (firstCall as unknown[])[0] as Record<string, unknown>;
    expect(sim.functionName).toBe("update");
    const args = sim.args as unknown[];
    expect(args[0]).toBe(RESOURCE_ID);
    expect(args[1]).toBe(EXISTING_TREASURY);
    expect(args[2]).toBe(EXISTING_BPS);
    expect(args[3]).toBe(numberToHex(42n, { size: 32 }));
    // pricingHash mirrors the deployer's zero word (getResource does not return it).
    expect(args[4]).toBe(`0x${"00".repeat(32)}`);
  });

  it("THROWS in production when IDENTITY_MINT_REQUIRED=1 but registries/key are unconfigured", () => {
    const env = { NODE_ENV: "production", IDENTITY_MINT_REQUIRED: "1" } as NodeJS.ProcessEnv;
    expect(() => resolveIdentity(env)).toThrow();
  });

  it("does NOT throw in production when IDENTITY_MINT_REQUIRED is unset (falls back to deferred)", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    const identity = resolveIdentity(env);
    expect((identity as { mode?: string }).mode).toBe("deferred");
  });
});

describe("resolveBondGate (env-gated bond gate seam)", () => {
  it("DEFAULT (no env) is pass-through: check resolves + bondReader reads 0n", async () => {
    const { bondGate, bondReader } = resolveBondGate({} as NodeJS.ProcessEnv);
    await expect(bondGate.check(RESOURCE_ID, "general")).resolves.toBeUndefined();
    expect(await bondReader(RESOURCE_ID)).toBe(0n);
  });

  it("ARMED (BOND_GATE_ENABLED=1 + mock client) enforces the real floor + reads the bond", async () => {
    const readContract = vi.fn(async (_args: unknown) => MIN_BOND_BASE_UNITS * 3n);
    const publicClient = { readContract } as never;
    const env = { BOND_GATE_ENABLED: "1" } as NodeJS.ProcessEnv;
    const { bondGate, bondReader } = resolveBondGate(env, { publicClient });

    // At/above the floor the gate resolves.
    await expect(bondGate.check(RESOURCE_ID, "general")).resolves.toBeUndefined();

    // The bondReader reads StakingVault.bonds and returns the on-chain value.
    expect(await bondReader(RESOURCE_ID)).toBe(MIN_BOND_BASE_UNITS * 3n);
    expect(readContract).toHaveBeenCalledWith({
      address: STAKING_VAULT,
      abi: stakingVaultAbi,
      functionName: "bonds",
      args: [RESOURCE_ID],
    });
  });

  it("ARMED rejects a below-floor bond with PublishRejected(bond_not_posted)", async () => {
    const readContract = vi.fn(async (_args: unknown) => MIN_BOND_BASE_UNITS - 1n);
    const publicClient = { readContract } as never;
    const env = { BOND_GATE_ENABLED: "1" } as NodeJS.ProcessEnv;
    const { bondGate } = resolveBondGate(env, { publicClient });

    await expect(bondGate.check(RESOURCE_ID, "general")).rejects.toBeInstanceOf(PublishRejected);
    await expect(bondGate.check(RESOURCE_ID, "general")).rejects.toMatchObject({
      reason: "bond_not_posted",
    });
  });
});
