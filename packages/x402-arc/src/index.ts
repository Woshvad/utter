// @utter/x402-arc - the importable x402 escrow payment middleware + paying-agent
// client for Arc Testnet. Phase 2 Wave 0 lands the shared store contract + the
// in-memory adapters every later wave's tests consume; subsequent waves extend
// this barrel with the accepts builder, the response gate, metering, the codec,
// the EIP-712 / EIP-3009 client signer, and the idempotency helpers.

// Shared persistence contract + in-memory adapters (PaymentStore / ResultStore)
export {
  type ReservationLock,
  type StoredResult,
  type PaymentStore,
  type ResultStore,
  InMemoryPaymentStore,
  InMemoryResultStore,
  DEFAULT_RESULT_TTL_SECONDS,
} from "./store";

// Wave 1/2 modules extend this barrel:
//   export { buildAccepts } from "./accepts";       // PAY-01 402 builder
//   export { requirePayment } from "./gate";        // PAY-04/05/06 escrow gate
//   export { computeMeteredAmount } from "./metering"; // PAY-07 metered math
//   export { encodePayment, decodePayment } from "./codec";
//   export { signDebitAuthorization } from "./client"; // PAY-03 (also via ./client subpath)
