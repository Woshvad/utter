// readUsdcBalance - the ONE USDC amount-formatting code path (CHAIN-03).
//
// The decimals trap (SPEC §6): USDC at 0x3600…0000 is simultaneously the 18-dp
// native gas token and the 6-dp ERC-20. To make a runtime `decimals()` read
// structurally unavoidable, all USDC amount formatting flows through this helper.
// It reads `decimals()` from the contract on every call and formats with viem
// `formatUnits` - so NO consumer can hardcode 6 or 18. There is intentionally no
// numeric decimals literal anywhere below.
import { formatUnits, isAddress, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abis";
import { USDC } from "./addresses";

export interface UsdcBalance {
  /** Raw on-chain balance in base units (bigint), from the 6-dp ERC-20 interface. */
  raw: bigint;
  /** Decimals read from the contract at runtime (expected 6) - never a literal. */
  decimals: number;
  /** Human-readable balance string, formatted with the runtime decimals. */
  formatted: string;
}

/**
 * Read an owner's USDC balance on Arc Testnet, applying the contract's runtime
 * `decimals()` to format the amount.
 *
 * @throws if `owner` is not a valid EVM address (ASVS V5 input validation).
 */
export async function readUsdcBalance(
  client: PublicClient,
  owner: Address,
): Promise<UsdcBalance> {
  if (!isAddress(owner)) {
    throw new Error(`readUsdcBalance: invalid owner address: ${owner}`);
  }

  // Read decimals() and balanceOf(owner) together. `decimals` comes from chain,
  // never a literal - this is the CHAIN-03 enforcement point.
  const [decimals, raw] = await Promise.all([
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
  ]);

  return {
    raw,
    decimals,
    formatted: formatUnits(raw, decimals),
  };
}
