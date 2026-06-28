// chain-id guard - asserts the single source of truth for the Arc chain id and
// CAIP-2 network. These are the values the identity/card path imports instead of
// re-typing 5042002 / eip155:5042002, so this test locks both the value AND the
// derivation: a mainnet cut changes arcTestnet.id and the constants must follow it
// without anyone re-typing a number. Offline (no RPC), unlike chain.test.ts.
import { describe, it, expect } from "vitest";
import { arcTestnet, ARC_CHAIN_ID, ARC_CAIP2_NETWORK } from "../src/index";

describe("Arc chain id single source of truth", () => {
  it("ARC_CHAIN_ID is the testnet value 5042002", () => {
    expect(ARC_CHAIN_ID).toBe(5042002);
  });

  it("ARC_CAIP2_NETWORK is the eip155 CAIP-2 string", () => {
    expect(ARC_CAIP2_NETWORK).toBe("eip155:5042002");
  });

  it("both constants are DERIVED from arcTestnet.id (no re-typed literal)", () => {
    expect(ARC_CHAIN_ID).toBe(arcTestnet.id);
    expect(ARC_CAIP2_NETWORK).toBe(`eip155:${arcTestnet.id}`);
  });
});
