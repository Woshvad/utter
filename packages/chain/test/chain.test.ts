// Live-RPC integration test - the Phase 0 Definition of Done (CHAIN-01/02/03).
// Connects to the live Arc Testnet RPC and asserts: chainId 5042002, the pinned
// §6 address export shape, decimals===6 read FROM CHAIN, and a bigint balance
// read for a wallet. Requires `.env.local` (gitignored) with ARC_RPC_URL +
// TEST_WALLET_ADDRESS.
import { describe, it, expect, beforeAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { isAddress, type Address } from "viem";
import {
  arcTestnet,
  createArcPublicClient,
  readUsdcBalance,
  USDC,
  EURC,
  MULTICALL3,
  PERMIT2,
  GATEWAY_WALLET,
  GATEWAY_MINTER,
} from "../src/index";

loadEnv({ path: ".env.local" });

const wallet = process.env.TEST_WALLET_ADDRESS as Address;
const client = createArcPublicClient(process.env.ARC_RPC_URL);

describe("Arc Testnet chain foundation", () => {
  beforeAll(() => {
    // Fail fast with an operator-friendly message instead of letting an unset
    // TEST_WALLET_ADDRESS surface as a confusing "invalid owner address:
    // undefined" deep inside readUsdcBalance. ARC_RPC_URL is optional: the
    // client falls back to the chain default RPC when it is absent.
    if (!process.env.TEST_WALLET_ADDRESS) {
      throw new Error(
        "set TEST_WALLET_ADDRESS in .env.local (a funded Arc Testnet wallet)",
      );
    }
  });

  it("connects to Arc Testnet (chainId 5042002)", async () => {
    // CHAIN-02 + threat T-00-03: a wrong-network / hijacked RPC is caught here
    // before any balance is trusted.
    expect(arcTestnet.id).toBe(5042002);
    expect(await client.getChainId()).toBe(arcTestnet.id);
  });

  it("exports the pinned Arc §6 addresses (export shape)", () => {
    // CHAIN-02 export-shape gate: a typo'd or dropped constant fails the suite
    // instead of passing green. Pure assertion, no RPC.
    expect(USDC).toBe("0x3600000000000000000000000000000000000000");

    for (const addr of [EURC, MULTICALL3, PERMIT2, GATEWAY_WALLET, GATEWAY_MINTER]) {
      expect(typeof addr).toBe("string");
      expect(addr.length).toBe(42);
      expect(addr.startsWith("0x")).toBe(true);
      expect(isAddress(addr)).toBe(true);
    }
  });

  it("reads USDC decimals at runtime (6, ERC-20 interface)", async () => {
    // CHAIN-03: the `6` here is asserted as a value READ FROM CHAIN - the only
    // place 6 may appear. It is never used as a conversion literal in src/.
    const { decimals } = await readUsdcBalance(client, wallet);
    expect(decimals).toBe(6);
  });

  it("reads a wallet's USDC balance (bigint; >0n once funded)", async () => {
    const { raw, formatted } = await readUsdcBalance(client, wallet);
    // HARD gate: wiring proven (read returns a bigint) even if unfunded.
    expect(typeof raw).toBe("bigint");
    // Funded-wallet check (RESEARCH Pitfall 5; faucet https://faucet.circle.com).
    expect(raw).toBeGreaterThan(0n);
    // Never log a private key - only the formatted balance.
    console.log(`USDC balance: ${formatted}`);
  });
}, 30_000);
