// @utter/x402-arc/client - the paying-agent entrypoint (Phase 7 buyer SDK imports
// this subpath WITHOUT pulling in the facilitator). Wave 1 lands the EIP-712
// DebitAuthorization signer (PAY-03, locked UtterEscrow domain) and the EIP-3009
// `exact` typed-data signer (PAY-08, Arc USDC domain) here, both via Viem
// signTypedData - never hand-rolled.
//
// Wave 0 keeps this subpath resolvable (the package.json `./client` export points
// here) by re-exporting the shared store types the client retries against; the
// signer functions are appended in Wave 1.
export type { ReservationLock, StoredResult } from "./store";
