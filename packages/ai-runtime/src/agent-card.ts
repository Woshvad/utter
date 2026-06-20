// agent-card.ts - the A2A v0.3.0 AgentCard builder + ajv validator.
//
// buildAgentCard(spec) returns the A2A v0.3.0 FLAT card shape (top-level
// protocolVersion / url / capabilities / defaultInputModes / defaultOutputModes /
// skills) plus the Utter x402 payment block. The x402 asset/escrow come from
// @utter/chain (USDC / PAYMENT_ESCROW) - NEVER re-literal'd here (Pitfall 2
// discipline, mirrors services/deployer/src/inject-x402.ts:22,90-101). Phase 4
// does no amount math; pricing is passed through from the spec.
//
// A2A version note (RESEARCH Pitfall 6): A2A v1.0.0 (2026-06-09) restructured the
// card into supportedInterfaces[] and removed top-level protocolVersion/url. The
// SPEC §9.9 sketch and the Phase 5 marketplace consumer assume the FLAT v0.3.0
// shape, so we target v0.3.0 and the validator REJECTS the v1.0.0 shape. v1.0.0 is
// a recorded Phase 5 migration.
//
// Deploy-time fields (url, payTo, agentId, health, bond, escrow target slug) are
// emitted as placeholders that validateAgentCard does NOT require to be final -
// Phase 3/5 inject the finals.
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { USDC, PAYMENT_ESCROW } from "@utter/chain";
import type { ResourceSpec } from "./types.js";

/** The A2A protocol version this builder targets (the last flat-shape release). */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** A short slug derived from the prompt (lowercase, hyphenated, bounded). */
function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "resource";
}

/**
 * Build the A2A v0.3.0 flat AgentCard + Utter x402 block from a ResourceSpec. The
 * x402 asset/escrow are imported from @utter/chain (never re-literal'd). Deploy-time
 * fields are placeholders finalized at deploy (Phase 3/5).
 */
export function buildAgentCard(spec: ResourceSpec): Record<string, unknown> {
  const slug = slugify(spec.prompt);
  const description = spec.prompt.trim();
  return {
    // A2A v0.3.0 flat shape.
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: slug,
    description,
    // PLACEHOLDER - finalized at deploy (slug + wildcard domain).
    url: `https://${slug}.resources.example`,
    version: "1.0.0",
    // MVP: request/response only. Streaming is Out of Scope.
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: slug,
        name: slug,
        description,
        tags: ["utter", "x402"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    // The Utter x402 payment block. asset/escrow from @utter/chain (never literal).
    x402: {
      scheme: "utter-escrow",
      network: "eip155:5042002",
      chainId: 5042002,
      asset: USDC,
      escrow: PAYMENT_ESCROW,
      pricing: spec.pricing,
      // PLACEHOLDER - the resourceId payTo is finalized at deploy.
      payTo: `placeholder-${slug}`,
    },
    cache: { ttlSeconds: 30 },
    // Phase 5 placeholders - identity mint / health scorer / staking bond.
    identity: { standard: "erc-8004", chainId: 5042002, agentId: "placeholder" },
    health: { verified: false, score: null },
    bond: { posted: false },
  };
}

/**
 * The pinned A2A v0.3.0 flat-card schema. Requires the A2A fields + the Utter x402
 * block. Deploy-time fields (url, payTo, agentId, health, bond) are OPTIONAL so a
 * pre-deploy card validates. `additionalProperties:false` at the top level REJECTS
 * the v1.0.0 `supportedInterfaces` shape (Pitfall 6): a card built with
 * supportedInterfaces instead of top-level protocolVersion/url fails this schema.
 */
const A2A_V030_CARD_SCHEMA = {
  $id: "agent-card.json",
  type: "object",
  additionalProperties: false,
  required: [
    "protocolVersion",
    "name",
    "description",
    "version",
    "capabilities",
    "defaultInputModes",
    "defaultOutputModes",
    "skills",
    "x402",
  ],
  properties: {
    // Pin the version to the flat-shape release; a v1.0.0 card (which removes this
    // top-level field) fails `required` + `additionalProperties:false`.
    protocolVersion: { type: "string", const: A2A_PROTOCOL_VERSION },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    url: { type: "string" }, // optional deploy-time field
    version: { type: "string", minLength: 1 },
    capabilities: {
      type: "object",
      required: ["streaming"],
      properties: { streaming: { type: "boolean" } },
    },
    defaultInputModes: { type: "array", items: { type: "string" }, minItems: 1 },
    defaultOutputModes: { type: "array", items: { type: "string" }, minItems: 1 },
    skills: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "name", "description"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          inputModes: { type: "array", items: { type: "string" } },
          outputModes: { type: "array", items: { type: "string" } },
        },
      },
    },
    x402: {
      type: "object",
      required: ["scheme", "network", "chainId", "asset", "escrow", "pricing"],
      properties: {
        scheme: { type: "string", const: "utter-escrow" },
        network: { type: "string", const: "eip155:5042002" },
        chainId: { type: "integer", const: 5042002 },
        asset: { type: "string" },
        escrow: { type: "string" },
        pricing: { type: "object" },
        payTo: { type: "string" }, // optional deploy-time field
      },
    },
    cache: { type: "object" },
    identity: { type: "object" },
    health: { type: "object" },
    bond: { type: "object" },
  },
} as const;

// Compile once with the SAME ajv@8.20.0 + ajv-formats@3.0.1 the workspace pins
// (single copy, mirrors @utter/x402-arc classify.ts). strict:false tolerates the
// const keyword on a non-enum without warnings.
const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
const validateCard: ValidateFunction = ajv.compile(A2A_V030_CARD_SCHEMA);

/** The result of validateAgentCard: valid + the ajv error messages on failure. */
export interface AgentCardValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a card against the pinned A2A v0.3.0 flat schema. Returns valid for a
 * built card and invalid for a v1.0.0 `supportedInterfaces` card (or any card
 * missing the required A2A/x402 fields).
 */
export function validateAgentCard(card: unknown): AgentCardValidationResult {
  const valid = validateCard(card);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateCard.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
  );
  return { valid: false, errors };
}
