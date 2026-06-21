// @utter/treasury - the SCL-03/SCL-04 home: EURC payout routing + USDC<->EURC
// swap (StableFX) and cross-chain escrow funding (CCTP V2) (SPEC §12; CONTEXT
// "packages/treasury").
//
// This is the Wave 0 barrel stub. The feature waves replace it with the
// PayoutRouter (USDC default / EURC opt-in, reading decimals() at runtime - never
// a literal 6), the StableFxAdapter (interface + MockStableFx default + gated
// LiveStableFx), and the CctpFunder (burn -> mock-attest -> receiveMessage mint
// -> credit escrow; poll-and-credit default; CCTP destination domain 26).
//
// LIVE-GATED NOTE: StableFX is an RFQ engine needing an off-chain quote partner
// and the live CCTP round-trip needs Circle Iris attestations + a funded
// cross-chain wallet, so both live halves are operator-gated; the autonomous path
// runs the deterministic mock adapters.

export {};
