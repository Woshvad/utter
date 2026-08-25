// live-discovery.ts - the LIVE MCP discovery source (Discovery/Playground-real subtask B).
//
// This is the live source the buyer MCP server uses to LIST real endpoints. It is
// operator-gated by the transport (the live bin path runs only when an operator provisions
// it), and it is exercised here offline via an injected fetcher so the read is fully unit
// tested without a deployed marketplace. It reads the PUBLIC marketplace GET /resources
// (the IndexRecord projection; reads are public, no bearer) and projects each row to a
// DiscoveredCard.
//
// Trust: the money/identity fields a buyer pays against are NEVER taken from an untrusted
// row. escrow/asset come from the TRUSTED @utter/chain constants (PAYMENT_ESCROW / USDC)
// and payTo is the resourceId (the escrow target IS the resourceId; design invariant). The
// discovery LIST is display-only: the real pay path (client.pay -> discover() ->
// readCardInputs) re-validates the served card and re-pins escrow/asset/payTo/cap BEFORE
// signing, so a wrong marketplace row cannot author a bad payment. openapi is best-effort
// (a typed input shape when the resource serves /openapi.json, else the passthrough
// envelope), and the openapi helper NEVER throws.
//
// NO stdout writes anywhere (stdout is the JSON-RPC frame channel - Pitfall 1). Global
// fetch only; NO new external dependency. packages/buyer-sdk only (the marketplace row
// shape is mirrored inline so @utter/marketplace stays out of the buyer-sdk graph).
import type { CardListSource, DiscoveredCard } from "./tools.js";
import type { FetchLike } from "../discover.js";
import { PAYMENT_ESCROW, USDC } from "@utter/chain";

/**
 * The marketplace GET /resources row shape (the IndexRecord JSON projection). Mirrored
 * inline so @utter/marketplace stays out of the buyer-sdk graph. reputation + bond are
 * decimal base-unit STRINGS in the JSON (the server serializes the bigint fields to
 * strings); the row is UNTRUSTED - only display fields are read from it.
 */
interface IndexRow {
  resourceId: string;
  agentId: string;
  slug: string;
  category: string;
  pricing: { model: string; base: string; perKB: string; max: string };
  reputation: string;
  uptime: number;
  health: { verified: boolean; score: number | null };
  bond: string;
  cardUrl: string;
  active: boolean;
}

/** The A2A card path suffix the cardUrl carries (stripped to derive the resource base). */
const CARD_PATH = "/.well-known/agent-card.json";

/**
 * Best-effort openapi read for one resource. Derives the resource base by stripping the
 * trailing agent-card path from the cardUrl, then GETs /openapi.json. On a 200 with an
 * object body it returns the served object (the inputSchema is derived from it); on ANY
 * failure (non-200, a thrown fetch, a non-object body) it returns {} so deriveInputShape
 * falls back to the passthrough envelope - a working untyped call tool. openapi is NOT
 * money-critical, so this helper NEVER throws.
 */
async function fetchOpenapiBestEffort(
  cardUrl: string,
  fetcher: FetchLike,
): Promise<Record<string, unknown>> {
  try {
    const resourceBase = cardUrl.endsWith(CARD_PATH)
      ? cardUrl.slice(0, -CARD_PATH.length)
      : cardUrl.replace(/\/+$/, "");
    const res = await fetcher(`${resourceBase}/openapi.json`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) return {};
    const body = await res.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Build the LIVE discovery card source. It reads the PUBLIC marketplace GET /resources and
 * projects each row to a DiscoveredCard. The fetcher is injectable (defaults to the global
 * fetch); tests drive it offline.
 */
export function createLiveCardSource(opts: {
  marketplaceIndexUrl: string;
  fetcher?: FetchLike;
  /**
   * An optional allow-list of resourceIds this source is SCOPED to. When present and
   * non-empty, only rows whose resourceId is in the list are projected (case-insensitive,
   * 0x-normalized). This is what a per-endpoint Claude Code plugin sets (via UTTER_RESOURCE_IDS)
   * so its bundled buyer MCP exposes ONLY that one endpoint's call tool. Empty/undefined =
   * no scoping (the full marketplace, the default). The scope is a DISPLAY/registration
   * filter only; it never authors a money field (the pay gate re-pins escrow/asset/payTo/cap
   * on the served card before signing).
   */
  resourceIds?: string[];
}): CardListSource {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.marketplaceIndexUrl.replace(/\/+$/, "");
  // Normalize the scope to a lowercased, 0x-stripped Set for O(1), case-insensitive
  // membership. A blank/whitespace id is dropped so a stray "" never scopes to nothing.
  const scope = new Set(
    (opts.resourceIds ?? [])
      .map((id) => id.trim().toLowerCase().replace(/^0x/, ""))
      .filter((id) => id.length > 0),
  );
  const scoped = scope.size > 0;

  return async (query?: string): Promise<DiscoveredCard[]> => {
    const res = await fetcher(`${base}/resources`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) {
      throw new Error(
        `utter-buyer-mcp: marketplace ${base}/resources returned HTTP ${res.status}`,
      );
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error(
        `utter-buyer-mcp: marketplace ${base}/resources did not return a JSON array`,
      );
    }
    const rows = body as IndexRow[];

    // Scope filter FIRST (a per-endpoint plugin's UTTER_RESOURCE_IDS allow-list): keep only
    // rows whose resourceId is in the scope Set (case-insensitive, 0x-normalized). Applied
    // BEFORE the query filter and the per-row openapi fetch, so a scoped source never even
    // fetches openapi for out-of-scope rows. Empty scope = the full marketplace (default).
    const inScope = scoped
      ? rows.filter((row) => scope.has((row.resourceId ?? "").toLowerCase().replace(/^0x/, "")))
      : rows;

    // Optional query filter, applied BEFORE the per-row openapi fetch so we never fetch
    // openapi for filtered-out rows. Matches slug, category, or resourceId (lowercased).
    const q = query?.trim().toLowerCase();
    const matched =
      q && q !== ""
        ? inScope.filter((row) => {
            const slug = (row.slug ?? "").toLowerCase();
            const category = (row.category ?? "").toLowerCase();
            const resourceId = (row.resourceId ?? "").toLowerCase();
            return slug.includes(q) || category.includes(q) || resourceId.includes(q);
          })
        : inScope;

    const cards: DiscoveredCard[] = [];
    for (const row of matched) {
      // Money discipline (WR-05): the row cap/bond strings are UNTRUSTED. Validate they are
      // plain base-unit integers BEFORE BigInt() so a non-numeric value yields a clean,
      // typed shape error instead of a raw SyntaxError. NO 1e6/decimals literal anywhere -
      // the values are already denominated in base units on the row.
      const maxRaw = row.pricing?.max;
      if (typeof maxRaw !== "string" || !/^\d+$/.test(maxRaw)) {
        throw new Error(
          `utter-buyer-mcp: resource ${row.resourceId} pricing.max ${JSON.stringify(maxRaw)} ` +
            `is not a base-unit integer`,
        );
      }
      const bondRaw = row.bond;
      if (typeof bondRaw !== "string" || !/^\d+$/.test(bondRaw)) {
        throw new Error(
          `utter-buyer-mcp: resource ${row.resourceId} bond ${JSON.stringify(bondRaw)} ` +
            `is not a base-unit integer`,
        );
      }

      const openapi = await fetchOpenapiBestEffort(row.cardUrl, fetcher);

      cards.push({
        resourceId: row.resourceId,
        // The IndexRecord carries no human title; slug is the stable label.
        name: row.slug,
        // TRUSTED constants + design invariant, never row-derived (the pay gate re-pins
        // these on the served card before signing).
        escrow: PAYMENT_ESCROW,
        asset: USDC,
        payTo: row.resourceId,
        // Base-unit pricing STRINGS, copied verbatim (NO decimals literal).
        pricing: {
          model: row.pricing.model,
          base: row.pricing.base,
          perKB: row.pricing.perKB,
          max: row.pricing.max,
        },
        capBaseUnits: BigInt(maxRaw),
        verified: row.health?.verified === true,
        agentId: row.agentId,
        bondPosted: BigInt(bondRaw) > 0n,
        openapi,
      });
    }
    return cards;
  };
}
