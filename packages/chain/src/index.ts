// @utter/chain - the single import point for the Arc Testnet chain foundation
// (CHAIN-02). Every later package imports chain constants, the ERC-20 ABI, the
// public-client factory, and the runtime-decimals USDC helper from here.

// Chain object + public client factory
export { arcTestnet, createArcPublicClient } from "./arc";

// The single source of truth for the Arc chain id + CAIP-2 network, both derived
// from arcTestnet.id. The identity/card path imports these instead of re-typing
// 5042002 / eip155:5042002, so a mainnet cut to arcTestnet.id reflows everywhere.
export { ARC_CHAIN_ID, ARC_CAIP2_NETWORK } from "./arc";

// Wallet (write-path) client factory for the relayer signer pool (Phase 2)
export { createArcWalletClient } from "./wallet";

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
  CCTP_TOKEN_MINTER,
  CCTP_DOMAIN,
  STABLEFX_FX_ESCROW,
  CREATE2_FACTORY,
} from "./addresses";

// Pinned Utter Phase 1 contract addresses (deployed on Arc Testnet; SPEC §6)
export {
  RESOURCE_REGISTRY,
  PAYMENT_ESCROW,
  PAYMENT_SPLITTER,
  STAKING_VAULT,
} from "./addresses";

// Minimal ERC-20 ABI
export { erc20Abi } from "./abis";

// Phase 2 write-path ABIs: escrow debit/Debited, splitter distribute, erc3009 exact
export { escrowAbi, splitterAbi, erc3009Abi } from "./abis";

// Phase 5 ABIs: StakingVault deposit/slash/refund + Slashed/Refunded events,
// ResourceRegistry register/pause/slashAuthorization/getResource/isActive, and the
// three empty ERC-8004 reference ABIs (Plan 02 pins these post-CREATE2-deploy).
export {
  stakingVaultAbi,
  registryAbi,
  identityAbi,
  reputationAbi,
  validationAbi,
} from "./abis";

// Runtime-decimals() USDC balance helper (CHAIN-03)
export { readUsdcBalance, type UsdcBalance } from "./usdc";
