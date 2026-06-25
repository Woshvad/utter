// register-resource.test.ts - the on-chain ResourceRegistry registration step
// (design §5.2). registerResourceIfNeeded drives ONE write through the injected
// admin walletClient (register is onlyOwner), guarded by an injected reader's
// isActive idempotency check. The two contracts/clients are INJECTED so this runs
// with spies and NO chain.
//
// LOAD-BEARING: creatorBps is a RATIO against 10000, NEVER a USDC amount - the spy
// asserts the exact register() args, the shared resourceId, the ZERO32 advisory
// fields, and that an already-active id writes NOTHING (the redeploy no-op). The
// AlreadyRegistered race resolves to idempotent success; a registered-but-paused id
// is flagged, not auto-unpaused.
import { describe, it, expect, vi } from "vitest";
import { RESOURCE_REGISTRY, registryAbi } from "@utter/chain";
import {
  registerResourceIfNeeded,
  type RegisterResourceParams,
  type RegistryAdminWriter,
  type RegistryReader,
} from "../src/register-resource";

const RESOURCE_ID = `0x${"ab".repeat(32)}` as `0x${string}`;
const CREATOR = `0x${"11".repeat(20)}` as `0x${string}`;
const TREASURY = `0x${"22".repeat(20)}` as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO32 = `0x${"00".repeat(32)}` as `0x${string}`;
const REGISTER_TX = `0x${"ee".repeat(32)}` as `0x${string}`;

function params(over: Partial<RegisterResourceParams> = {}): RegisterResourceParams {
  return { resourceId: RESOURCE_ID, creator: CREATOR, treasury: TREASURY, creatorBps: 7000, ...over };
}

/** A spy admin writer recording each register call. */
function mockAdmin(opts: { revert?: string } = {}) {
  const writeContract = vi.fn(async (_args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }) => {
    if (opts.revert) throw new Error(opts.revert);
    return REGISTER_TX;
  });
  return { admin: { writeContract } as RegistryAdminWriter, writeContract };
}

/** A spy reader answering isActive with `active` + acking the receipt wait. */
function mockReader(active: boolean) {
  const readContract = vi.fn(async (_a: {
    address: `0x${string}`;
    abi: unknown;
    functionName: "isActive";
    args: readonly [`0x${string}`];
  }) => active);
  const waitForTransactionReceipt = vi.fn(async (_a: { hash: `0x${string}` }) => ({ status: "success" }));
  return { reader: { readContract, waitForTransactionReceipt } as RegistryReader, readContract, waitForTransactionReceipt };
}

describe("register-resource - idempotency", () => {
  it("skips the write when isActive(resourceId) is already true (redeploy no-op)", async () => {
    const { admin, writeContract } = mockAdmin();
    const { reader, readContract } = mockReader(true);

    const result = await registerResourceIfNeeded({ admin, reader }, params());

    expect(result).toEqual({ registered: false, alreadyActive: true });
    expect(writeContract).not.toHaveBeenCalled();
    expect(readContract).toHaveBeenCalledOnce();
    // The idempotency read targets the registry's isActive with the shared id.
    expect(readContract).toHaveBeenCalledWith({
      address: RESOURCE_REGISTRY,
      abi: registryAbi,
      functionName: "isActive",
      args: [RESOURCE_ID],
    });
  });

  it("writes when isActive is false (the first deploy of the label)", async () => {
    const { admin, writeContract } = mockAdmin();
    const { reader } = mockReader(false);

    const result = await registerResourceIfNeeded({ admin, reader }, params());

    expect(result).toEqual({ registered: true, alreadyActive: false, registrationTx: REGISTER_TX });
    expect(writeContract).toHaveBeenCalledOnce();
  });
});

describe("register-resource - the register() args (creatorBps is a ratio)", () => {
  it("writes register(resourceId, creator, treasury, creatorBps, ZERO32, ZERO32) with the shared id", async () => {
    const { admin, writeContract } = mockAdmin();
    const { reader, waitForTransactionReceipt } = mockReader(false);

    await registerResourceIfNeeded({ admin, reader }, params({ creatorBps: 7000 }));

    expect(writeContract).toHaveBeenCalledWith({
      address: RESOURCE_REGISTRY,
      abi: registryAbi,
      functionName: "register",
      // agentId + pricingHash default to the zero word (advisory indexer fields).
      args: [RESOURCE_ID, CREATOR, TREASURY, 7000, ZERO32, ZERO32],
    });
    // creatorBps is passed as the integer ratio 7000, NOT any token-scaled amount.
    const call = writeContract.mock.calls[0]![0];
    expect(call.args[3]).toBe(7000);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: REGISTER_TX });
  });
});

describe("register-resource - local validation (mirrors the contract guards)", () => {
  it("rejects a zero creator (ZeroAddress would lock the split)", async () => {
    const { admin, writeContract } = mockAdmin();
    await expect(
      registerResourceIfNeeded({ admin }, params({ creator: ZERO_ADDR })),
    ).rejects.toThrow(/non-zero/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("rejects a zero treasury", async () => {
    const { admin, writeContract } = mockAdmin();
    await expect(
      registerResourceIfNeeded({ admin }, params({ treasury: ZERO_ADDR })),
    ).rejects.toThrow(/non-zero/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("rejects creatorBps > 10000 (InvalidBps); it is a ratio, never an amount", async () => {
    const { admin, writeContract } = mockAdmin();
    await expect(
      registerResourceIfNeeded({ admin }, params({ creatorBps: 10_001 })),
    ).rejects.toThrow(/creatorBps/);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe("register-resource - race + paused handling", () => {
  it("treats an AlreadyRegistered revert as idempotent (registered-but-paused flagged)", async () => {
    // isActive read false (not active), but the write reverts AlreadyRegistered -
    // the id exists but is PAUSED. Surface a flagged result, do NOT auto-unpause.
    const { admin } = mockAdmin({ revert: "execution reverted: AlreadyRegistered()" });
    const { reader } = mockReader(false);

    const result = await registerResourceIfNeeded({ admin, reader }, params());

    expect(result).toEqual({ registered: false, alreadyActive: false, registeredButPaused: true });
  });

  it("rethrows any non-AlreadyRegistered revert (a real failure)", async () => {
    const { admin } = mockAdmin({ revert: "execution reverted: OwnableUnauthorizedAccount()" });
    const { reader } = mockReader(false);

    await expect(registerResourceIfNeeded({ admin, reader }, params())).rejects.toThrow(/Ownable/);
  });

  it("writes without a reader (no idempotency read available)", async () => {
    const { admin, writeContract } = mockAdmin();
    const result = await registerResourceIfNeeded({ admin }, params());
    expect(result.registered).toBe(true);
    expect(writeContract).toHaveBeenCalledOnce();
  });
});
