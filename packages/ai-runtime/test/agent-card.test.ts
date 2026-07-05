// agent-card.test.ts - the A2A v0.3.0 flat card builder + validator (GEN-01).
// Offline unit test. Proves: the built card is the flat v0.3.0 shape with the Utter
// x402 block sourced from @utter/chain, the validator accepts it, and REJECTS the
// A2A v1.0.0 `supportedInterfaces` shape (RESEARCH Pitfall 6).
import { describe, it, expect } from "vitest";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import {
  buildAgentCard,
  finalizeAgentCard,
  validateAgentCard,
  A2A_PROTOCOL_VERSION,
} from "../src/agent-card.js";
import type { ResourceSpec } from "../src/types.js";

const spec: ResourceSpec = {
  prompt: "Echo the input text back with its length.",
  runtime: "node",
  pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
};

describe("buildAgentCard (A2A v0.3.0 + x402)", () => {
  it("returns the A2A v0.3.0 flat shape with the required top-level fields", () => {
    const card = buildAgentCard(spec) as Record<string, unknown>;
    expect(card.protocolVersion).toBe("0.3.0");
    expect(A2A_PROTOCOL_VERSION).toBe("0.3.0");
    expect(typeof card.name).toBe("string");
    expect(typeof card.description).toBe("string");
    expect(typeof card.url).toBe("string");
    expect(typeof card.version).toBe("string");
    expect(card.capabilities).toEqual({ streaming: false });
    expect(card.defaultInputModes).toEqual(["application/json"]);
    expect(card.defaultOutputModes).toEqual(["application/json"]);
    expect(Array.isArray(card.skills)).toBe(true);
    expect((card.skills as unknown[]).length).toBeGreaterThan(0);
  });

  it("carries the x402 block with asset/escrow imported from @utter/chain (not re-literal'd)", () => {
    const card = buildAgentCard(spec) as { x402: Record<string, unknown> };
    expect(card.x402.scheme).toBe("utter-escrow");
    expect(card.x402.network).toBe("eip155:5042002");
    expect(card.x402.chainId).toBe(5042002);
    // Strict equality to the @utter/chain exports - never a hand-typed literal.
    expect(card.x402.asset).toBe(USDC);
    expect(card.x402.escrow).toBe(PAYMENT_ESCROW);
    expect(card.x402.pricing).toEqual(spec.pricing);
  });

  it("capabilities.streaming is false (MVP request/response only)", () => {
    const card = buildAgentCard(spec) as { capabilities: { streaming: boolean } };
    expect(card.capabilities.streaming).toBe(false);
  });

  it("emits deploy-time fields (url, payTo, agentId, health, bond) as placeholders not required-final", () => {
    const card = buildAgentCard(spec) as Record<string, unknown>;
    // They are present as placeholders but the validator does not require them final.
    expect(card.url).toBeDefined();
    expect((card.x402 as { payTo: string }).payTo).toContain("placeholder");
    expect((card.identity as { agentId: string }).agentId).toBe("placeholder");
    expect((card.health as { verified: boolean }).verified).toBe(false);
    expect((card.bond as { posted: boolean }).posted).toBe(false);
  });
});

describe("finalizeAgentCard (stamp the real resourceId payTo + url)", () => {
  const RESOURCE_ID = `0x${"ab".repeat(32)}`;

  it("replaces the placeholder x402.payTo with the resourceId (the marketplace payTo-binding gate needs this)", () => {
    const built = JSON.stringify(buildAgentCard(spec));
    // The built card carries the placeholder payTo (proof the finalize is doing real work).
    expect((JSON.parse(built) as { x402: { payTo: string } }).x402.payTo).toContain("placeholder");

    const finalized = JSON.parse(
      finalizeAgentCard(built, { resourceId: RESOURCE_ID, url: "https://echo.resources.example.com" }),
    ) as Record<string, unknown>;

    expect((finalized.x402 as { payTo: string }).payTo).toBe(RESOURCE_ID);
    expect(finalized.url).toBe("https://echo.resources.example.com");
    // The finalized card stays validateAgentCard-valid and preserves the rest of the x402 block.
    expect(validateAgentCard(finalized).valid).toBe(true);
    const x402 = finalized.x402 as Record<string, unknown>;
    expect(x402.scheme).toBe("utter-escrow");
    expect(x402.asset).toBe(USDC);
    expect(x402.escrow).toBe(PAYMENT_ESCROW);
    expect(x402.pricing).toEqual(spec.pricing);
  });

  it("leaves url unchanged when none is provided (only payTo is stamped)", () => {
    const built = JSON.stringify(buildAgentCard(spec));
    const before = (JSON.parse(built) as { url: string }).url;
    const finalized = JSON.parse(finalizeAgentCard(built, { resourceId: RESOURCE_ID })) as {
      url: string;
      x402: { payTo: string };
    };
    expect(finalized.x402.payTo).toBe(RESOURCE_ID);
    expect(finalized.url).toBe(before);
  });
});

describe("validateAgentCard (pinned A2A v0.3.0 schema)", () => {
  it("accepts a freshly built card", () => {
    const result = validateAgentCard(buildAgentCard(spec));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a built card even without the optional deploy-time url/payTo", () => {
    const card = buildAgentCard(spec) as Record<string, unknown>;
    delete card.url;
    delete (card.x402 as Record<string, unknown>).payTo;
    const result = validateAgentCard(card);
    expect(result.valid).toBe(true);
  });

  it("REJECTS the A2A v1.0.0 supportedInterfaces shape (Pitfall 6)", () => {
    // v1.0.0 removed top-level protocolVersion/url and restructured into
    // supportedInterfaces[]. The pinned v0.3.0 schema must reject it.
    const v1Card = {
      name: "echo",
      description: "echo",
      version: "1.0.0",
      capabilities: { streaming: false },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{ id: "echo", name: "echo", description: "echo" }],
      supportedInterfaces: [{ transport: "JSONRPC", url: "https://x.example" }],
      x402: {
        scheme: "utter-escrow",
        network: "eip155:5042002",
        chainId: 5042002,
        asset: USDC,
        escrow: PAYMENT_ESCROW,
        pricing: spec.pricing,
      },
    };
    const result = validateAgentCard(v1Card);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a card missing the x402 block", () => {
    const card = buildAgentCard(spec) as Record<string, unknown>;
    delete card.x402;
    expect(validateAgentCard(card).valid).toBe(false);
  });
});
