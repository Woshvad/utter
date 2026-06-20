// @utter/chain - the single import point for the Arc Testnet chain foundation
// (CHAIN-02). Every later package imports chain constants, the ERC-20 ABI, the
// public-client factory, and the runtime-decimals USDC helper from here.

// Chain object + public client factory
export { arcTestnet, createArcPublicClient } from "./arc";

// Pinned Arc Testnet address constants (SPEC §6)
export {
  USDC,
  EURC,
  MULTICALL3,
  PERMIT2,
  GATEWAY_WALLET,
  GATEWAY_MINTER,
  CCTP_TOKEN_MESSENGER,
  CCTP_MESSAGE_TRANSMITTER,
  STABLEFX_FX_ESCROW,
  CREATE2_FACTORY,
} from "./addresses";

// Minimal ERC-20 ABI
export { erc20Abi } from "./abis";

// Runtime-decimals() USDC balance helper (CHAIN-03)
export { readUsdcBalance, type UsdcBalance } from "./usdc";
