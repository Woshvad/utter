// @utter/treasury - the SCL-03/SCL-04 home: EURC payout routing + USDC<->EURC
// swap (StableFX) and cross-chain escrow funding (CCTP V2) (SPEC §12; CONTEXT
// "packages/treasury").
//
// LIVE-GATED NOTE: StableFX is an RFQ engine needing an off-chain quote partner
// and the live CCTP round-trip needs Circle Iris attestations + a funded
// cross-chain wallet, so both live halves are operator-gated (RequiresLive*); the
// autonomous path runs the deterministic mock adapters (MockStableFx +
// MockAttestation). The PayoutRouter reads decimals() at runtime (never a literal
// 6) and the CctpFunder pins the CCTP destination domain to 26 from @utter/chain.

// SCL-03: StableFX swap seam (interface + mock default + gated live).
export {
  FX_ESCROW,
  MockStableFx,
  LiveStableFx,
  RequiresLiveStableFx,
  type Quote,
  type StableFxAdapter,
} from "./stablefx-adapter";

// SCL-03: payout routing (USDC default / EURC per-payee opt-in, runtime decimals).
export {
  PayoutRouter,
  type PayoutAsset,
  type PayeeConfig,
  type PayoutResult,
  type PayoutRouterDeps,
  type DecimalsReader,
  type SwapBounds,
} from "./payout-router";

// SCL-04: CCTP cross-chain escrow funding (burn -> attest -> mint -> credit).
export {
  CctpFunder,
  MockAttestation,
  LiveCctp,
  RequiresLiveCctp,
  InMemoryNonceStore,
  ShapeAttestationVerifier,
  type Attestation,
  type AttestationSource,
  type CctpChainWriter,
  type EscrowCreditStore,
  type FundResult,
  type CctpFunderDeps,
  type NonceStore,
  type AttestationVerifier,
} from "./cctp-funder";
