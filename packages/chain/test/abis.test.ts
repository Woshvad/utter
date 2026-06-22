// abis.test.ts - offline ABI-shape assertions for the studio wallet move-money path.
// Pure, no RPC, no .env.local, no ambient env reads: it only inspects the static ABI
// objects. Asserts the new entries the browser deposit/withdraw flow relies on exist
// with the exact name/inputs/mutability copied from contracts/src/PaymentEscrow.sol and
// the ERC-20 standard. Never encodes a decimals literal (amounts are uint256 base units).
import { describe, it, expect } from "vitest";
import { escrowAbi, erc20Abi } from "../src/abis";

type AbiFn = {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: { name?: string; type: string }[];
  outputs?: { type: string }[];
};

function fn(abi: readonly unknown[], name: string): AbiFn | undefined {
  return (abi as AbiFn[]).find((e) => e.type === "function" && e.name === name);
}

describe("escrowAbi withdraw entry (PaymentEscrow.withdraw)", () => {
  it("has a withdraw(uint256 amount) nonpayable function", () => {
    const withdraw = fn(escrowAbi, "withdraw");
    expect(withdraw).toBeDefined();
    expect(withdraw?.stateMutability).toBe("nonpayable");
    expect(withdraw?.inputs).toEqual([{ name: "amount", type: "uint256" }]);
    expect(withdraw?.outputs).toEqual([]);
  });

  it("still carries deposit(uint256 amount) (unchanged inflow)", () => {
    const deposit = fn(escrowAbi, "deposit");
    expect(deposit?.inputs).toEqual([{ name: "amount", type: "uint256" }]);
  });
});

describe("erc20Abi approve entry (standard ERC-20)", () => {
  it("has an approve(address spender, uint256 amount) -> (bool) function", () => {
    const approve = fn(erc20Abi, "approve");
    expect(approve).toBeDefined();
    expect(approve?.stateMutability).toBe("nonpayable");
    expect(approve?.inputs).toEqual([
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ]);
    expect(approve?.outputs).toEqual([{ type: "bool" }]);
  });

  it("has an allowance(owner, spender) -> (uint256) view", () => {
    const allowance = fn(erc20Abi, "allowance");
    expect(allowance?.stateMutability).toBe("view");
    expect(allowance?.outputs).toEqual([{ type: "uint256" }]);
  });

  it("still exposes decimals() so the runtime money scale is readable (no literal)", () => {
    const decimals = fn(erc20Abi, "decimals");
    expect(decimals?.stateMutability).toBe("view");
    expect(decimals?.outputs).toEqual([{ type: "uint8" }]);
  });
});
