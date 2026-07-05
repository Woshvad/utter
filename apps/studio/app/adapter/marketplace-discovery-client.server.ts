// marketplace-discovery-client.server.ts - the server-only READ client that lists the
// active resources from the marketplace SERVICE (the public A2A discovery surface). It is
// the discovery counterpart of marketplace-client.server.ts: where that module POSTs a
// publish (write, bearer-gated), this module GETs the discovery index (read, public).
//
// Discovery reads are PUBLIC: this client sends NO Authorization header and needs no
// secret. It mirrors marketplace-client.server.ts's diagnostic shapes (the network and
// non-ok branches build their messages from the target URL, the err.cause.code, and the
// marketplace's {error} field only); there is no bearer here so there is nothing to
// redact, but the same "could not be reached" prose is kept for a consistent operator
// experience.
//
// It reconstructs each row back into an IndexRecord with BIGINT money fields
// (reputation/bond via BigInt(); the marketplace serializes them as decimal-string base
// units to stay JSON-lossless), so the SAME pure filterResources + recordToCard pipeline
// the seeded local-dev path uses applies UNCHANGED to live records. When this client is
// bound, the marketplace SERVICE is the single source of discovery truth and the studio
// authors no money or identity value. No 1e6/6/18/decimals literal anywhere: pricing
// stays string base units and the money fields are reconstructed verbatim via BigInt().
//
// `.server.ts` so Vite keeps this node/fetch code out of the client bundle. The
// IndexRecord type is imported type-only (erased at build), so the @utter/marketplace
// runtime never enters the studio graph. No new external npm dependency (global fetch
// only). FAIL-LOUD: an unreachable or malformed marketplace THROWS a bearer-free
// diagnostic; it never silently returns an empty or fake list.
import type { IndexRecord } from "@utter/marketplace";

/**
 * The over-the-wire shape of one row from the marketplace's GET /resources. It is the
 * IndexRecord projection with the two bigint money fields serialized as decimal strings
 * (the marketplace stringifies reputation + bond so the JSON stays lossless; everything
 * else passes through). pricing.base/perKB/max are already strings (base units).
 */
interface ResourceRow {
  resourceId: unknown;
  creator: unknown;
  agentId: unknown;
  slug: unknown;
  category: unknown;
  pricing: { model: unknown; base: unknown; perKB: unknown; max: unknown } | undefined;
  reputation: unknown;
  uptime: unknown;
  health: { verified: unknown; score: unknown } | undefined;
  bond: unknown;
  cardUrl: unknown;
  active: unknown;
}

/** Assert a value is a non-empty string, throwing a clear bearer-free shape error. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `marketplace GET /resources returned a malformed row: ${field} is not a non-empty string`,
    );
  }
  return value;
}

/**
 * Reconstruct a decimal-string base-unit money field back into a bigint, throwing a clear
 * bearer-free shape error on a non-numeric value. The marketplace is the source of truth,
 * so a malformed amount is a fault we surface, never silently coerce or drop. No decimals
 * literal: BigInt() parses the base-unit string verbatim.
 */
function requireBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(
      `marketplace GET /resources returned a malformed row: ${field} is not a numeric string`,
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(
      `marketplace GET /resources returned a malformed row: ${field} ("${String(
        value,
      )}") is not a valid base-unit integer`,
    );
  }
}

/** Map one over-the-wire row to an IndexRecord, reconstructing the bigint money fields. */
function rowToRecord(raw: unknown): IndexRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("marketplace GET /resources returned a malformed row (not an object)");
  }
  const row = raw as ResourceRow;
  const pricing = row.pricing;
  if (typeof pricing !== "object" || pricing === null) {
    throw new Error("marketplace GET /resources returned a malformed row: pricing missing");
  }
  const health = row.health;
  if (typeof health !== "object" || health === null) {
    throw new Error("marketplace GET /resources returned a malformed row: health missing");
  }
  if (typeof row.uptime !== "number") {
    throw new Error(
      "marketplace GET /resources returned a malformed row: uptime is not a number",
    );
  }
  if (typeof row.active !== "boolean") {
    throw new Error(
      "marketplace GET /resources returned a malformed row: active is not a boolean",
    );
  }
  const record: IndexRecord = {
    resourceId: requireString(row.resourceId, "resourceId") as IndexRecord["resourceId"],
    agentId: requireString(row.agentId, "agentId"),
    slug: requireString(row.slug, "slug"),
    category: requireString(row.category, "category"),
    // pricing fields STAY strings (base units). No 1e6/decimals literal.
    pricing: {
      model: requireString(pricing.model, "pricing.model"),
      base: requireString(pricing.base, "pricing.base"),
      perKB: requireString(pricing.perKB, "pricing.perKB"),
      max: requireString(pricing.max, "pricing.max"),
    },
    // reputation + bond come back as decimal-string base units; reconstruct as bigint.
    reputation: requireBigInt(row.reputation, "reputation"),
    uptime: row.uptime,
    health: {
      verified: health.verified === true,
      score: typeof health.score === "number" ? health.score : null,
    },
    bond: requireBigInt(row.bond, "bond"),
    cardUrl: requireString(row.cardUrl, "cardUrl"),
    active: row.active,
  };
  // creator (optional/additive): the owner projection the durable marketplace persists. Carry
  // it back when present + address-shaped so the dashboard's ownership scope survives a studio
  // restart (a legacy row without it, or a malformed value, is left undefined, not thrown -
  // the ownership filter then falls back to the local-dev placeholder, matching no real wallet).
  if (typeof row.creator === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.creator)) {
    record.creator = row.creator as IndexRecord["creator"];
  }
  return record;
}

/**
 * Query the marketplace service's public discovery index. GETs {marketplaceUrl}/resources
 * with no Authorization header (reads are public) and no query params, fetching the FULL
 * active set; the caller (LiveAdapter.listMarketplace) applies the SAME pure
 * filterResources locally so full filter fidelity is preserved (the server only parses a
 * subset of criteria). Returns the reconstructed IndexRecord[] (bigint money fields).
 *
 * FAIL-LOUD: a network-level failure throws a bearer-free diagnostic naming the URL + the
 * cause code + an actionable hint (mirrors publishResource's network branch); a non-200
 * throws naming the status (+ any {error} detail); a non-array body or a malformed row
 * throws a clear shape error. It never returns an empty/fake list to mask a fault.
 */
export async function queryMarketplaceResources(opts: {
  marketplaceUrl: string;
}): Promise<IndexRecord[]> {
  const url = `${opts.marketplaceUrl.replace(/\/+$/, "")}/resources`;

  let res: Response;
  try {
    // Discovery reads are PUBLIC: NO Authorization header. No query params: the full
    // active set is fetched and filtered locally for full criteria fidelity.
    res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  } catch (err) {
    // A NETWORK-level failure (the marketplace unreachable) throws TypeError "fetch
    // failed" with the real reason in err.cause.code (ECONNREFUSED / ENOTFOUND /
    // ETIMEDOUT). Surface a diagnostic naming the target URL + the cause code + the
    // actionable fix. There is no bearer here, so nothing is redacted.
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    const codePart = typeof code === "string" ? ` (${code})` : "";
    throw new Error(
      `marketplace GET ${url} could not be reached${codePart}: ${(err as Error).message}. ` +
        "Check that the marketplace service is running and listening on that host:port, " +
        "and that MARKETPLACE_URL points at the marketplace host reachable from the " +
        "studio container.",
    );
  }

  // Read the body once. The discovery read returns a JSON array on 200 and a JSON {error}
  // on a fault; a non-JSON body falls back to undefined so the status alone shapes the
  // non-ok message.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const detail =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : "";
    throw new Error(
      detail
        ? `marketplace GET ${url} failed with HTTP ${res.status}: ${detail}`
        : `marketplace GET ${url} failed with HTTP ${res.status}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `marketplace GET ${url} returned a malformed body (expected a JSON array of resources)`,
    );
  }

  // Map every row (a malformed row throws; rows are never silently dropped). An empty
  // array is a valid result (no active resources), never an error.
  return parsed.map(rowToRecord);
}
