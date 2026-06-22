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

// --- MCP server (Plan 03, BUY-02/BUY-03): createMcpServer over StdioServerTransport ---
// The discovery + per-endpoint tools wrap createBuyerClient.pay; the buyer key is held in
// the client closure (never a tool arg/return/log). The per-tool/-day budget guard layers
// a soft cap over the on-chain signed-cap hard bound.
export { createMcpServer, createMcpServerAsync } from "./mcp/server.js";
export type {
  CreateMcpServerOptions,
  CreatedMcpServer,
  McpBuyerClient,
} from "./mcp/server.js";
export {
  buildDiscoveryTool,
  buildEndpointTool,
  endpointToolName,
} from "./mcp/tools.js";
export type {
  DiscoveredCard,
  DiscoveredPricing,
  CardListSource,
  BuiltTool,
  BuiltDiscoveryTool,
  ToolResult,
  PayFn,
  PrePayGuard,
  BudgetLifecycle,
} from "./mcp/tools.js";
export {
  createBudgetGuard,
  readBudgetCapsFromEnv,
} from "./mcp/budget.js";
export type {
  BudgetGuard,
  BudgetCaps,
  BudgetDecision,
  BudgetReservation,
  ReserveResult,
} from "./mcp/budget.js";

// --- Demo: the self-contained in-process DEMO wiring the bin boots by default ---
// An ephemeral throwaway wallet + the fixture transport (mock chain + debit-counting
// relayer) + a built-in echo card, so an agent can run the full discover->pay loop over
// stdio with NO real money, network, or deployed resource. Live mode stays operator-gated
// and fail-loud (RequiresLiveBuyerError).
export {
  createDemoWiring,
  createDemoTransport,
  createDemoBuyerWallet,
  demoCardSource,
  demoClientCardSource,
  DEMO_RESOURCE_ID,
} from "./demo.js";
export type { DemoWiring } from "./demo.js";
