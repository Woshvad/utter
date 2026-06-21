import { describe, it, expect } from "vitest";

// Wave 0 scaffold smoke test. It proves two things before any Phase 7 feature code
// lands: (1) the @utter/buyer-sdk member graph resolves the workspace:* edges onto
// the frozen payment stack, and (2) the installed @modelcontextprotocol/sdk@1.29.0
// import subpaths resolve cleanly (the phase's single [VERIFY] A1, Pitfall 4).
//
// No business logic, no secret/key material, no console output (the key-hygiene
// discipline starts here). This is a resolution + shape assertion only.

// (1) Known workspace symbols imported THROUGH the member graph. If any workspace:*
// edge is broken, these imports fail to resolve and the suite goes red.
import { escrowAbi, USDC, PAYMENT_ESCROW } from "@utter/chain";
import { signDebitAuthorization, retrieveByIdemKey } from "@utter/x402-arc";
import { validateAgentCard } from "@utter/ai-runtime";

// (2) The [VERIFY] A1 resolution: the PUBLISHED 1.29.0 subpaths are server/mcp.js and
// server/stdio.js (per the package exports "./*" wildcard). NOT the main-branch
// @modelcontextprotocol/server shorthand (an unreleased reorg). If these subpaths do
// not resolve, the import throws ERR_MODULE_NOT_FOUND and this file fails loud here,
// at Wave 0, before Plan 03 wires tools against the SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

describe("@utter/buyer-sdk scaffold", () => {
  it("resolves the workspace member graph (the workspace:* edges link)", () => {
    expect(escrowAbi).toBeDefined();
    expect(USDC).toBeDefined();
    expect(PAYMENT_ESCROW).toBeDefined();
    expect(typeof signDebitAuthorization).toBe("function");
    expect(typeof retrieveByIdemKey).toBe("function");
    expect(typeof validateAgentCard).toBe("function");
  });

  it("resolves the installed MCP SDK import subpaths (A1 [VERIFY] closed)", () => {
    // server/mcp.js + server/stdio.js resolve under @modelcontextprotocol/sdk@1.29.0.
    expect(typeof McpServer).toBe("function");
    expect(typeof StdioServerTransport).toBe("function");
  });
});
