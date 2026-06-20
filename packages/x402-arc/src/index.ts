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

// 402 accepts builder (PAY-01) + the pinned wire constants and entry types
export {
  buildAccepts,
  X402_VERSION,
  ARC_CAIP2_NETWORK,
  ESCROW_EIP712_DOMAIN,
  USDC_EIP712_DOMAIN,
  type Pricing,
  type EscrowEip712,
  type AcceptsEntry,
  type AcceptsBody,
  type ExactOption,
  type BuildAcceptsOpts,
} from "./accepts";

// Metered settle math (PAY-07): base + perKB*size + compute, clamped to cap
export { computeMeteredAmount } from "./metering";

// PaymentPayload base64 codec (ASVS V5 validated decode)
export {
  encodePayment,
  decodePayment,
  type PaymentPayload,
  type DebitAuthorizationMessage,
} from "./codec";

// AJV response classifier (PAY-06): success | declared_error | malfunction
export {
  buildClassifier,
  classifyResponse,
  type ResponseClass,
  type ClassifyResponse,
} from "./classify";

// Paying-agent signers (PAY-03 escrow, PAY-08 exact) - also via the ./client subpath
export {
  signDebitAuthorization,
  signExactTransfer,
  computeValidBefore,
  DEBIT_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  ESCROW_DOMAIN,
  USDC_DOMAIN,
  type SignerWalletClient,
  type DebitAuthorizationInput,
  type SignedDebitAuthorization,
  type TransferWithAuthorizationInput,
  type SignedExactTransfer,
} from "./client";

// Later wave extends this barrel:
//   export { requirePayment } from "./gate";        // PAY-04/05 escrow gate
