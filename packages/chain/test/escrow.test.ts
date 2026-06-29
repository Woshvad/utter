// escrow.test.ts - offline tests for the payout-surface reads (CHAIN-03).
// Pure, no RPC, no .env.local: a mock PublicClient whose readContract switches on
// functionName drives readEscrowBalance + readBondStatus. Asserts the runtime
// decimals discipline (decimals comes from chain, formatted via formatUnits), that
// the escrow balance is read against PAYMENT_ESCROW (NOT the wallet USDC), that the
// bond reads hit STAKING_VAULT, and that bad inputs throw.
import { describe, it, expect } from "vitest";
import type { Address, PublicClient } from "viem";
import { readEscrowBalance, readBondStatus, readWithdrawals } from "../src/escrow";
import { USDC, PAYMENT_ESCROW, STAKING_VAULT } from "../src/addresses";

const ACCOUNT = "0xDa8c5726f596E8dae99e6dDEBa8AEa1c8bE9A4a5" as Address;
const BOND_OWNER = "0x1111111111111111111111111111111111111111" as Address;
const RESOURCE_ID =
  "0x1234567890123456789012345678901234567890123456789012345678901234" as `0x${string}`;

// Build a mock PublicClient whose readContract resolves a value per (address,
// functionName) and records every call so the test can assert which contract was
// targeted. handlers is keyed by `${address}:${functionName}`.
type ReadArgs = { address: Address; functionName: string; args?: readonly unknown[] };
function mockClient(handlers: Record<string, unknown>) {
  const calls: ReadArgs[] = [];
  const client = {
    readContract: async (params: ReadArgs) => {
      calls.push(params);
      const key = `${params.address}:${params.functionName}`;
      if (!(key in handlers)) {
        throw new Error(`mockClient: unexpected read ${key}`);
      }
      return handlers[key];
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe("readEscrowBalance", () => {
  it("reads PaymentEscrow.balanceOf with runtime decimals and formats it", async () => {
    const { client, calls } = mockClient({
      [`${USDC}:decimals`]: 6,
      [`${PAYMENT_ESCROW}:balanceOf`]: 50_000_000n,
    });

    const balance = await readEscrowBalance(client, ACCOUNT);

    expect(balance).toEqual({ raw: 50_000_000n, decimals: 6, formatted: "50" });

    // The balanceOf MUST hit PAYMENT_ESCROW (the accrued internal balance), NOT
    // the USDC token (the wallet balance). decimals is read from USDC.
    const balanceCall = calls.find((c) => c.functionName === "balanceOf");
    expect(balanceCall?.address).toBe(PAYMENT_ESCROW);
    expect(balanceCall?.args).toEqual([ACCOUNT]);
    const decimalsCall = calls.find((c) => c.functionName === "decimals");
    expect(decimalsCall?.address).toBe(USDC);
  });

  it("throws on an invalid account address", async () => {
    const { client } = mockClient({});
    await expect(
      readEscrowBalance(client, "not-an-address" as Address),
    ).rejects.toThrow(/invalid account address/);
  });
});

describe("readBondStatus", () => {
  it("reads bonds + bondOwner + cooldownEnds from STAKING_VAULT with runtime decimals", async () => {
    const { client, calls } = mockClient({
      [`${STAKING_VAULT}:bonds`]: 5_000_000n,
      [`${STAKING_VAULT}:bondOwner`]: BOND_OWNER,
      [`${STAKING_VAULT}:cooldownEnds`]: 0n,
      [`${USDC}:decimals`]: 6,
    });

    const status = await readBondStatus(client, RESOURCE_ID);

    expect(status).toEqual({
      amount: 5_000_000n,
      owner: BOND_OWNER,
      cooldownEnds: 0n,
      decimals: 6,
    });

    // The three bond reads MUST hit STAKING_VAULT; decimals comes from USDC.
    for (const name of ["bonds", "bondOwner", "cooldownEnds"]) {
      const call = calls.find((c) => c.functionName === name);
      expect(call?.address, `${name} should target STAKING_VAULT`).toBe(STAKING_VAULT);
      expect(call?.args).toEqual([RESOURCE_ID]);
    }
    expect(calls.find((c) => c.functionName === "decimals")?.address).toBe(USDC);
  });

  it("throws on a non-bytes32 resourceId", async () => {
    const { client } = mockClient({});
    await expect(
      readBondStatus(client, "0x1234" as `0x${string}`),
    ).rejects.toThrow(/invalid bytes32 resourceId/);
  });
});

// A getLogs-capable mock PublicClient: readContract resolves USDC decimals; getLogs
// returns the canned logs and records the params so the test can assert the target,
// the event, and the indexed-account filter. The canned log shape is faithful to
// viem's decoded getLogs output: { args: { account, amount }, transactionHash,
// blockNumber }.
type GetLogsArgs = {
  address: Address;
  event: { name: string };
  args?: Record<string, unknown>;
  fromBlock?: bigint;
  toBlock?: unknown;
};
function mockLogClient(decimals: number, logs: unknown[]) {
  const getLogsCalls: GetLogsArgs[] = [];
  const client = {
    readContract: async (params: { address: Address; functionName: string }) => {
      if (params.functionName !== "decimals") {
        throw new Error(`mockLogClient: unexpected read ${params.functionName}`);
      }
      return decimals;
    },
    getLogs: async (params: GetLogsArgs) => {
      getLogsCalls.push(params);
      return logs;
    },
  } as unknown as PublicClient;
  return { client, getLogsCalls };
}

const TX_A =
  "0xaaaa000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
const TX_B =
  "0xbbbb000000000000000000000000000000000000000000000000000000000002" as `0x${string}`;

describe("readWithdrawals", () => {
  it("decodes Withdrawn logs to {tx, amount, blockNumber}, newest-first, with runtime decimals", async () => {
    // Two logs out of block order; the 20n one must sort first (newest-first).
    const { client, getLogsCalls } = mockLogClient(6, [
      { args: { account: ACCOUNT, amount: 1_000_000n }, transactionHash: TX_A, blockNumber: 10n },
      { args: { account: ACCOUNT, amount: 3_000_000n }, transactionHash: TX_B, blockNumber: 20n },
    ]);

    const history = await readWithdrawals(client, ACCOUNT);

    expect(history.decimals).toBe(6);
    expect(history.records).toEqual([
      { tx: TX_B, amount: 3_000_000n, blockNumber: 20n },
      { tx: TX_A, amount: 1_000_000n, blockNumber: 10n },
    ]);

    // The getLogs call MUST target PAYMENT_ESCROW, filter by the Withdrawn event, and
    // pin the indexed account topic via args.
    expect(getLogsCalls).toHaveLength(1);
    const call = getLogsCalls[0]!;
    expect(call.address).toBe(PAYMENT_ESCROW);
    expect(call.event.name).toBe("Withdrawn");
    expect(call.args).toEqual({ account: ACCOUNT });
    expect(call.fromBlock).toBe(0n);
  });

  it("honors a pinned fromBlock and always scans to the chain head", async () => {
    const { client, getLogsCalls } = mockLogClient(6, []);
    await readWithdrawals(client, ACCOUNT, { fromBlock: 12_345n });
    const call = getLogsCalls[0]!;
    // The pinned window start is forwarded; toBlock is always the head so a pinned
    // fromBlock bounds only the SCAN START, never silently truncating recent history.
    expect(call.fromBlock).toBe(12_345n);
    expect(call.toBlock).toBe("latest");
  });

  it("returns an empty record list (with decimals) when there are no logs", async () => {
    const { client } = mockLogClient(6, []);
    const history = await readWithdrawals(client, ACCOUNT);
    expect(history).toEqual({ records: [], decimals: 6 });
  });

  it("drops a pending log (null blockNumber / transactionHash) from the records", async () => {
    const { client } = mockLogClient(6, [
      { args: { account: ACCOUNT, amount: 1_000_000n }, transactionHash: TX_A, blockNumber: 10n },
      { args: { account: ACCOUNT, amount: 2_000_000n }, transactionHash: null, blockNumber: null },
    ]);
    const history = await readWithdrawals(client, ACCOUNT);
    expect(history.records).toEqual([{ tx: TX_A, amount: 1_000_000n, blockNumber: 10n }]);
  });

  it("throws on an invalid account address", async () => {
    const { client } = mockLogClient(6, []);
    await expect(
      readWithdrawals(client, "not-an-address" as Address),
    ).rejects.toThrow(/invalid account address/);
  });
});
