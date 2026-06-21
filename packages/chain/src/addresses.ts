// Pinned Arc Testnet contract addresses (CHAIN-02).
// Source: Utter-SPEC.md §6 (Contracts table); every value re-confirmed against
// https://docs.arc.io/arc/references/contract-addresses and on-chain reads this
// session. This module is the ONE place addresses are pinned - every later
// package imports from here so a re-pin (e.g. mainnet) touches one file.
//
// Decimals note: USDC and EURC expose a 6-decimal ERC-20 interface. That fact is
// recorded in prose ONLY - never encode `6` as a usable amount-math literal here.
// All USDC amount formatting reads `decimals()` at runtime via `readUsdcBalance`.

/** USDC - 6-decimal ERC-20 interface (also the 18-dp native gas token). Core money path, all phases. */
export const USDC = "0x3600000000000000000000000000000000000000" as const;

/** EURC - 6-decimal ERC-20. Consumed by StableFX / EURC payouts (Phase 8). */
export const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;

/** Multicall3 - batched reads. Also wired into the chain object's `contracts`. Used across phases. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Permit2 - signature approvals for the no-deposit metered settlement path (Phase 2). */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** Gateway `GatewayWallet` - nanopayments / chain-abstracted USDC (Phase 2/8 settlement). */
export const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

/** Gateway `GatewayMinter` - companion to GatewayWallet (Phase 2/8 settlement). */
export const GATEWAY_MINTER = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as const;

/** CCTP `TokenMessengerV2` - cross-chain USDC funding (Arc CCTP domain 26; Phase 8). */
export const CCTP_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;

/** CCTP `MessageTransmitterV2` - cross-chain message receipt (Phase 8). */
export const CCTP_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;

/** CCTP `TokenMinterV2` - mint authority on the Arc destination (Phase 8). */
export const CCTP_TOKEN_MINTER = "0xb43db544E2c27092c107639Ad201b3dEfAbcF192" as const;

/**
 * Arc CCTP destination domain id - the pinned value SCL-04's CctpFunder reads so
 * no plan ever hardcodes a bare literal. Authoritative value is 26 (confirmed by
 * Circle's supported-chains page and docs.arc.io); the "7" search snippet is wrong
 * and must never appear near CCTP code (Phase 8).
 */
export const CCTP_DOMAIN = 26 as const;

/** StableFX `FxEscrow` - USDC↔EURC settlement for EURC payouts (Phase 8). */
export const STABLEFX_FX_ESCROW = "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" as const;

/** CREATE2 Factory - deterministic contract deploys (Phase 3+ contracts/sandbox). */
export const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

// Utter Phase 1 contracts, deployed and verified on Arc Testnet (chainId 5042002)
// on 2026-06-20 via contracts/script/Deploy.s.sol. Source verified on ArcScan
// (Blockscout). A deposit -> debit(<=cap) -> withdraw cycle confirmed the 70/30
// creator/treasury split on-chain. These are testnet deployments whose owner,
// escrow admin (relayer), and platform treasury are all the deployer EOA
// (0xDa8c5726f596E8dae99e6dDEBa8AEa1c8bE9A4a5); a production deploy sets distinct
// roles (see contracts/DEPLOY.md). Re-pin on redeploy.

/** ResourceRegistry - per-resource config + indexer events + pause/slash auth (Phase 1). */
export const RESOURCE_REGISTRY = "0x12aafa5a70c3aD8Bd3a52252744f9F7Aa073E362" as const;

/** PaymentEscrow - primary money path: capped EIP-712 debit + inline 70/30 split (Phase 1). */
export const PAYMENT_ESCROW = "0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154" as const;

/** StakingVault (with in-vault InsurancePool) - creator bonds, slash, refunds (Phase 1). */
export const STAKING_VAULT = "0x15573Cb5a391F1023317bd49b076A7FE664FdE8B" as const;

/** PaymentSplitter - sample flat-path (exact) splitter wired at deploy (Phase 1). */
export const PAYMENT_SPLITTER = "0x71375fC7cA1EA9d2f0dFc44d454B37AbD3cCe510" as const;
