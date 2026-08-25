// adapters.ts - map the two real Utter representations of a published endpoint onto the
// generator's PluginResource: the marketplace GET /resources row (the IndexRecord JSON
// projection) and the A2A agent card. Both are UNTRUSTED external JSON; the base-unit
// pricing strings are validated as integers before they are rendered (a clean shape error,
// never a raw crash), mirroring the buyer SDK's discover/live-discovery discipline.
import type { PluginPricing, PluginResource } from "./types.js";
import { isBytes32 } from "./naming.js";

/** The marketplace GET /resources row shape (mirrored inline; only display fields are read). */
export interface MarketplaceIndexRow {
  resourceId: string;
  agentId?: string;
  slug: string;
  category?: string;
  description?: string;
  pricing: { model?: string; base?: string; perKB?: string; max?: string };
  reputation?: string;
  uptime?: number;
  health?: { verified?: boolean; score?: number | null };
  bond?: string;
  cardUrl?: string;
  creator?: string;
  active?: boolean;
}

/** Validate a base-unit pricing string is a plain non-negative integer (fail-closed). */
function baseUnitInt(value: unknown, field: string, resourceId: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(
      `plugin-gen: resource ${resourceId} ${field} ${JSON.stringify(value)} is not a base-unit integer`,
    );
  }
  return value;
}

/** Read + validate the metered pricing block from an untrusted source. */
function readPricing(
  raw: { model?: string; base?: string; perKB?: string; max?: string } | undefined,
  resourceId: string,
): PluginPricing {
  const p = raw ?? {};
  return {
    model: typeof p.model === "string" && p.model.length > 0 ? p.model : "metered",
    base: baseUnitInt(p.base ?? "0", "pricing.base", resourceId),
    perKB: baseUnitInt(p.perKB ?? "0", "pricing.perKB", resourceId),
    max: baseUnitInt(p.max ?? "0", "pricing.max", resourceId),
  };
}

/** Map a marketplace GET /resources row to a PluginResource (display projection only). */
export function resourceFromIndexRow(row: MarketplaceIndexRow): PluginResource {
  if (!isBytes32(row.resourceId)) {
    throw new Error(`plugin-gen: index row resourceId ${JSON.stringify(row.resourceId)} is not bytes32`);
  }
  const slug = typeof row.slug === "string" && row.slug.length > 0 ? row.slug : "endpoint";
  const description =
    typeof row.description === "string" && row.description.trim().length > 0
      ? row.description.trim()
      : `The ${slug} Utter endpoint.`;
  const bondPosted =
    typeof row.bond === "string" && /^\d+$/.test(row.bond) ? BigInt(row.bond) > 0n : false;
  return {
    resourceId: row.resourceId,
    slug,
    description,
    category: typeof row.category === "string" ? row.category : undefined,
    pricing: readPricing(row.pricing, row.resourceId),
    verified: row.health?.verified === true,
    agentId: typeof row.agentId === "string" ? row.agentId : undefined,
    bondPosted,
    cardUrl: typeof row.cardUrl === "string" ? row.cardUrl : undefined,
    creator: typeof row.creator === "string" ? row.creator : undefined,
  };
}

/**
 * Map an A2A agent card (the served /.well-known/agent-card.json) to a PluginResource. The
 * resourceId is the card's x402.payTo (the escrow target IS the resourceId, a design
 * invariant). Useful when generating from a single known endpoint's card.
 */
export function resourceFromAgentCard(
  card: Record<string, unknown>,
  opts: { cardUrl?: string; creator?: string; category?: string } = {},
): PluginResource {
  const x402 = (card.x402 as Record<string, unknown> | undefined) ?? {};
  const payTo = x402.payTo;
  if (typeof payTo !== "string" || !isBytes32(payTo)) {
    throw new Error(
      `plugin-gen: agent card x402.payTo ${JSON.stringify(payTo)} is not a bytes32 resourceId`,
    );
  }
  const name = typeof card.name === "string" && card.name.length > 0 ? card.name : "endpoint";
  const description =
    typeof card.description === "string" && card.description.trim().length > 0
      ? card.description.trim()
      : `The ${name} Utter endpoint.`;
  const identity = (card.identity as Record<string, unknown> | undefined) ?? {};
  const health = (card.health as Record<string, unknown> | undefined) ?? {};
  const bond = (card.bond as Record<string, unknown> | undefined) ?? {};
  return {
    resourceId: payTo,
    slug: name,
    title: name,
    description,
    category: opts.category,
    pricing: readPricing(
      x402.pricing as { model?: string; base?: string; perKB?: string; max?: string } | undefined,
      payTo,
    ),
    verified: health.verified === true,
    agentId: typeof identity.agentId === "string" ? identity.agentId : undefined,
    bondPosted: bond.posted === true,
    cardUrl: opts.cardUrl,
    creator: opts.creator,
  };
}
