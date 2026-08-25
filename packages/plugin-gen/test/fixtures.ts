// fixtures.ts - real + synthetic inputs the generator tests build against.
//
// LIVE_UTC_CARD is the ACTUAL served agent card of the deployed demo endpoint
// (return-the-current-utc-time-as-json.resources.utter.technology), captured verbatim so the
// generator is proven against a real published resource, not only synthetic data.
import type { PluginResource } from "../src/types.js";

/** The real deployed endpoint's A2A agent card (captured from the live resource). */
export const LIVE_UTC_CARD: Record<string, unknown> = {
  protocolVersion: "0.3.0",
  name: "return-the-current-utc-time-as-json",
  description: "return the current utc time as json",
  url: "https://return-the-current-utc-time-as-json.resources.utter.technology",
  version: "1.0.0",
  capabilities: { streaming: false },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "return-the-current-utc-time-as-json",
      name: "return-the-current-utc-time-as-json",
      description: "return the current utc time as json",
      tags: ["utter", "x402"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
  ],
  x402: {
    scheme: "utter-escrow",
    network: "eip155:5042002",
    chainId: 5042002,
    asset: "0x3600000000000000000000000000000000000000",
    escrow: "0x87DDD6df70A5CDb5c161C65bfE15e0F6942DD154",
    pricing: { model: "metered", base: "10000", perKB: "0", max: "10000" },
    payTo: "0xf8fa3ed7e7443ca91838eb6ecb7b35473c2d2452b9c2913d787617bcfa54f5ce",
  },
  cache: { ttlSeconds: 30 },
  identity: { standard: "erc-8004", chainId: 5042002, agentId: "placeholder" },
  health: { verified: false, score: null },
  bond: { posted: false },
};

/** The real endpoint's resourceId (its x402.payTo) - the tool-name + scope basis. */
export const LIVE_UTC_RESOURCE_ID =
  "0xf8fa3ed7e7443ca91838eb6ecb7b35473c2d2452b9c2913d787617bcfa54f5ce";

/** The expected buyer MCP call tool name for the live endpoint (mirrors endpointToolName). */
export const LIVE_UTC_TOOL_NAME =
  "utter_call_f8fa3ed7e7443ca91838eb6ecb7b35473c2d2452b9c2913d787617bcfa54f5ce";

/** A synthetic marketplace GET /resources row (the IndexRecord JSON projection). */
export function indexRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: `0x${"a1".repeat(32)}`,
    agentId: "42",
    slug: "weather-now",
    category: "data",
    pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
    reputation: "3",
    uptime: 0.99,
    health: { verified: true, score: 0.95 },
    bond: "1000000",
    cardUrl: "https://weather-now.resources.utter.app/.well-known/agent-card.json",
    active: true,
    ...overrides,
  };
}

/** A ready-made PluginResource for the plugin builders. */
export function pluginResource(overrides: Partial<PluginResource> = {}): PluginResource {
  return {
    resourceId: `0x${"b2".repeat(32)}`,
    slug: "translate-text",
    title: "Translate text",
    description: "translate text between languages",
    category: "compute",
    pricing: { model: "metered", base: "2000", perKB: "50", max: "8000" },
    verified: true,
    agentId: "7",
    bondPosted: true,
    cardUrl: "https://translate-text.resources.utter.app/.well-known/agent-card.json",
    ...overrides,
  };
}
