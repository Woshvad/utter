// wallet.test.ts - offline unit test for createArcWalletClientFromKey.
//
// Asserts the from-key buyer/signer factory binds the account derived from the
// raw key, so a caller building a buyer wallet through @utter/chain gets a wallet
// whose account.address equals privateKeyToAccount(key).address. No network: this
// only constructs the client and reads its bound account address.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { arcTestnet, createArcWalletClientFromKey } from "../src/index";

// A fixed, well-known throwaway test key (viem's canonical example key). It holds
// no funds and is never used to broadcast here - this test never touches an RPC.
const TEST_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("createArcWalletClientFromKey (offline)", () => {
  it("binds the account derived from the raw private key", () => {
    const expected = privateKeyToAccount(TEST_KEY).address;
    const wallet = createArcWalletClientFromKey(TEST_KEY);
    expect(wallet.account.address).toBe(expected);
    // The wallet is bound to Arc Testnet (chainId 5042002).
    expect(wallet.chain.id).toBe(arcTestnet.id);
  });

  it("honors an explicit RPC override without touching the network", () => {
    const wallet = createArcWalletClientFromKey(TEST_KEY, "https://rpc.example.invalid");
    // Construction succeeds and still binds the same account; no call is made.
    expect(wallet.account.address).toBe(privateKeyToAccount(TEST_KEY).address);
  });
});
