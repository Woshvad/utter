// @utter/buyer-sdk - the demand side: a reference paying-agent client and (Plan 03) an
// MCP stdio server that exposes discovered Utter endpoints as agent tools (Phase 7).
//
// createBuyerClient (this plan, BUY-01): discover -> ensureDeposit -> pay ->
// retrieveByIdemKey, a thin orchestration over the FROZEN @utter/x402-arc pay-loop
// primitives (the locked UtterEscrow/1 signing domain). The pay loop is a refactor of
// runTestEndpoint (apps/marketplace/src/test-endpoint.ts), not a new flow: exactly one
// debit <= cap, the 70/30 split, and exactly-once across a disconnect. The buyer wallet
// key is held in the client closure - never returned from a public method, never logged.
//
// selectBuyerTransport is the injectable seam (selectAdapter idiom): the in-process
// facilitator + mock chain by default; the live HTTPS + Arc transport is operator-gated
// and fail-loud (RequiresLiveBuyerError).
//
// Plan 03 fills the ./mcp surface (createMcpServer over stdio) on top of this client.

// --- The paying-agent client (BUY-01) ---
export { createBuyerClient } from "./client.js";
export type {
  BuyerClient,
  CreateBuyerClientOptions,
  BuyerWalletClient,
  ResourceRef,
  PayRequest,
  PayResult,
  RecoveredResult,
} from "./client.js";

// --- Discover: card fetch + validateAgentCard HARD-gate + the pay-input projection ---
export { discover } from "./discover.js";
export type {
  DiscoverResult,
  DiscoverDeps,
  CardPayInputs,
  CardSource,
  FetchLike,
} from "./discover.js";

// --- Deposit: ensureDeposit (deposit-once, runtime-decimals, approve-then-deposit) ---
export { ensureDeposit, usdcApprovalAbi } from "./deposit.js";
export type {
  EnsureDepositOptions,
  EnsureDepositResult,
  DepositWalletClient,
} from "./deposit.js";

// --- Transport: the selectBuyerTransport seam + the operator-gated live error ---
export {
  selectBuyerTransport,
  createFixtureTransport,
  createLiveTransport,
  RequiresLiveBuyerError,
  MAX_TIMEOUT_SECONDS,
  SETTLE_BUFFER_SECONDS,
  FIXTURE_FACILITATOR_URL,
} from "./transport.js";
export type { BuyerTransport, FixtureTransportDeps } from "./transport.js";
