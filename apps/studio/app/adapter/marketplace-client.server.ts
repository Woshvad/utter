// marketplace-client.server.ts - the server-only client that lists a deployed resource
// in the marketplace SERVICE (the A2A discovery surface agents hit), closing the publish
// loop after a successful deploy.
//
// This module POSTs the built A2A card + the moderation prompt to the marketplace's
// authenticated publish endpoint (POST {MARKETPLACE_URL}/resources). It mirrors
// deployer-client.server.ts: a `.server.ts` name so Vite excludes it from the client
// bundle (MARKETPLACE_AUTH_SECRET and the publish-call code never reach the browser
// graph), and the same bearer-discipline + bearer-free diagnostic shapes.
//
// SECURITY: the bearer goes ONLY in the Authorization header. It is never logged, never
// returned to the browser, and never placed in a thrown message. The non-ok and network
// paths build their messages from the HTTP status, the marketplace's {error}/{reason}
// fields, and the err.cause.code only (request headers are never echoed).
//
// The studio never imports @utter/marketplace: the request/response shapes are mirrored
// inline so the marketplace package never enters the studio graph. No new external npm
// dependency is added (global fetch only).

/**
 * The publish input the studio controls: the moderation prompt, the keystone resourceId,
 * the listing category, the built A2A card object (parsed from the bundle's
 * agent-card.json), the served card URL, and the discovery slug.
 */
export interface PublishParams {
  prompt: string;
  resourceId: string;
  category: string;
  card: Record<string, unknown>;
  cardUrl: string;
  slug: string;
}

/**
 * Publish a deployed resource to the marketplace service. POSTs the params with
 * Authorization: Bearer to {marketplaceUrl}/resources and maps the marketplace's response
 * to a terminal outcome. On 201 returns the parsed { listed, agentId }; on 202 (held for
 * review) / 403 (blocked) / any other non-2xx it throws a bearer-free message naming the
 * status and the marketplace's reason; on a network failure it throws a bearer-free
 * diagnostic naming the URL + the cause code + an actionable hint (mirrors streamDeploy).
 */
export async function publishResource(
  params: PublishParams,
  opts: { marketplaceUrl: string; authSecret: string },
): Promise<{ listed: boolean; agentId?: string }> {
  const url = `${opts.marketplaceUrl.replace(/\/+$/, "")}/resources`;

  // The publish body: exactly the fields the marketplace's parsePublishRequest reads.
  const body = {
    prompt: params.prompt,
    resourceId: params.resourceId,
    category: params.category,
    card: params.card,
    cardUrl: params.cardUrl,
    slug: params.slug,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // The bearer goes ONLY here. It is never logged or echoed into any message below.
      headers: {
        authorization: `Bearer ${opts.authSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A NETWORK-level failure (the marketplace unreachable) throws TypeError "fetch
    // failed" with the real reason in err.cause.code (ECONNREFUSED / ENOTFOUND /
    // ETIMEDOUT). Surface a BEARER-FREE diagnostic naming the target URL (host:port only,
    // never the secret) + the cause code + the actionable fix, so the build stream shows
    // WHY instead of an opaque "fetch failed". The request body/headers are never echoed.
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    const codePart = typeof code === "string" ? ` (${code})` : "";
    throw new Error(
      `marketplace POST ${url} could not be reached${codePart}: ${(err as Error).message}. ` +
        "Check that the marketplace service is running and listening on that host:port, " +
        "and that MARKETPLACE_URL points at the marketplace host reachable from the " +
        "studio container.",
    );
  }

  // Read the response body once. The marketplace returns JSON on every documented status;
  // a non-JSON body falls back to an empty object so the status alone shapes the message.
  let parsed: { listed?: unknown; agentId?: unknown; error?: unknown; reason?: unknown } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // A non-JSON body is fine: the status-only message paths below still apply.
  }

  // 201 Created: the resource is listed for discovery. Return the parsed outcome.
  if (res.status === 201) {
    const listed = parsed.listed === true;
    const agentId = typeof parsed.agentId === "string" ? parsed.agentId : undefined;
    return { listed, agentId };
  }

  // The reason string the marketplace attaches to a held/blocked/error outcome.
  const reason =
    typeof parsed.reason === "string"
      ? parsed.reason
      : typeof parsed.error === "string"
        ? parsed.error
        : "";

  // 202 Accepted: held for review by moderation, NOT listed. Throw a clear review message.
  if (res.status === 202) {
    throw new Error(
      `marketplace held the resource for review (not listed): ${reason || "held by moderation"}`,
    );
  }

  // 403 Forbidden: blocked by moderation, NOT listed. Throw a clear blocked message.
  if (res.status === 403) {
    throw new Error(
      `marketplace blocked the resource (not listed): ${reason || "blocked by moderation"}`,
    );
  }

  // Any other non-2xx: name the status + the marketplace's {error}/{reason} detail only.
  const detail = reason || "";
  throw new Error(
    detail
      ? `marketplace POST /resources failed with HTTP ${res.status}: ${detail}`
      : `marketplace POST /resources failed with HTTP ${res.status}`,
  );
}
