// requireCreator.server.ts - STU-05 / ASVS V4 access control (D-STU-05).
//
// Two gates the creator-only surfaces use:
//   requireCreator(request)            - session gate: the request MUST carry a valid
//                                        SIWE session; otherwise redirect to /auth
//                                        (or 401 for non-document requests). Gates
//                                        /create, /dashboard, /wallet, payout, redeploy.
//   requireResourceOwner(request, id)  - ownership gate: the authenticated address
//                                        MUST equal the resource's creator; a
//                                        different creator gets a 403 (T-06-PRIVESC,
//                                        the cross-creator privilege-escalation block).
//
// Ownership is checked by reading the resource creator THROUGH the adapter (the same
// read-through seam every loader uses) and comparing case-insensitively against the
// session address - the frontend never re-derives identity. This module makes zero
// console.* calls (no secret/address logging in the gate path).
import { redirect } from "react-router";
import { getAuthAddress } from "./session.server.js";
import { selectAdapter } from "../adapter/select.js";

/**
 * Require an authenticated creator. Returns the SIWE-authenticated address when the
 * request carries a valid session; otherwise redirects document navigations to /auth
 * and throws a 401 for data/API requests (so an XHR/fetch gets a status, not HTML).
 *
 * Throws (never returns) on the unauthenticated path - callers use it as a guard at
 * the top of a loader/action: `const creator = await requireCreator(request);`.
 */
export async function requireCreator(request: Request): Promise<string> {
  const address = await getAuthAddress(request);
  if (address) return address;

  // Unauthenticated. A document navigation gets a redirect to the SIWE login; a
  // data request (fetch/XHR) gets a 401 so the client can surface it.
  const accept = request.headers.get("Accept") ?? "";
  if (accept.includes("text/html")) {
    throw redirect("/auth");
  }
  throw new Response(JSON.stringify({ error: "unauthenticated" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Require that the authenticated creator OWNS the given resource. First enforces the
 * session gate (requireCreator), then reads the resource creator through the adapter
 * and rejects with 403 when it differs from the authenticated address. This is the
 * per-action ownership check that blocks one creator from acting on another's
 * resource (payout/redeploy/delist) - the elevation-of-privilege mitigation.
 *
 * @returns the authenticated (and verified-owner) address
 */
export async function requireResourceOwner(
  request: Request,
  resourceId: string,
): Promise<string> {
  const address = await requireCreator(request);

  const adapter = selectAdapter(process.env);
  let creator: string;
  try {
    const detail = await adapter.getResourceDetail(resourceId);
    creator = detail.creator;
  } catch {
    // Unknown resource - surface a not-found rather than leak ownership detail.
    throw new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Case-insensitive address compare (EIP-55 checksum casing must not gate access).
  if (address.toLowerCase() !== creator.toLowerCase()) {
    throw new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return address;
}
