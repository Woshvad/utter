// @utter/buyer-sdk - the demand side: a reference paying-agent client and an MCP
// stdio server that exposes discovered Utter endpoints as agent tools (Phase 7).
//
// Two surfaces feed off this barrel once the feature plans land:
// - createBuyerClient (Plan 02): discover -> ensureDeposit -> pay -> retrieveByIdemKey,
//   a thin orchestration over the frozen @utter/x402-arc pay-loop primitives. The
//   buyer wallet key is read once server-side and never reaches the caller.
// - createMcpServer (Plan 03): an @modelcontextprotocol/sdk McpServer over stdio that
//   registers a discovery tool plus per-endpoint call tools (price and reputation
//   surfaced per tool), wired to the client pay flow with zero human key management.
//
// This is the Wave 0 scaffold barrel. It carries no runtime surface yet; Plan 02
// replaces the placeholder below with the real client export.

export const BUYER_SDK_SCAFFOLD = "@utter/buyer-sdk" as const;
