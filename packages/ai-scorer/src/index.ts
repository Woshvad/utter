// @utter/ai-scorer - the off-chain reputation scorer + AI moderation backend
// (SCR-01/02/03, MOD-01/02). It polls the indexed call ledger on a fixed
// interval, computes a per-resource reputation score against a latency budget,
// drives the registry pause / StakingVault slash takedown loop, and runs the
// moderation backend (keyword default when MODERATION_BACKEND is empty, mirroring
// AI_RUNTIME_GENERATOR).
//
// This is the Wave 0 barrel: the feature waves append the scorer interval loop,
// the score model, the moderation backend, and the takedown driver. Nothing is
// exported yet.
export {};
