// auth.tsx - the STU-05 SIWE handshake route (D-STU-05).
//
//   GET  /auth  (loader)  -> issue a one-time nonce, store it on the session, and
//                            return it as JSON for the browser to embed in the
//                            SiweMessage it signs. The Set-Cookie carries the nonce
//                            session (signed httpOnly).
//   POST /auth  (action)  -> read {message, signature}, verify against the session
//                            nonce + bound domain (verifySiwe), CONSUME the nonce
//                            (one-time), and commit a session cookie carrying the
//                            authenticated address on success.
//
// CSRF (T-06-CSRF): the SameSite=lax session cookie + a same-origin check on the
// state-changing POST. The session nonce is consumed on success so a captured
// message cannot be replayed (T-06-SIWE-REPLAY). Zero console.* - the nonce and the
// signature never reach a log line.
import * as React from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { getSession, commitSession } from "../auth/session.server.js";
import { issueNonce, verifySiwe, SIWE_NONCE_KEY } from "../auth/siwe.server.js";
import { SiweModal } from "../components/auth/SiweModal.js";

/** GET: issue a one-time nonce, persist it on the session, return it for signing. */
export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const session = await getSession(request.headers.get("Cookie"));
  const nonce = issueNonce();
  session.set(SIWE_NONCE_KEY, nonce);
  return new Response(JSON.stringify({ nonce }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": await commitSession(session),
    },
  });
}

/** Reject a cross-origin POST (the CSRF same-origin guard for the state change). */
function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return; // no Origin header (same-origin GET-style); SameSite cookie still gates
  const host = request.headers.get("Host");
  try {
    const originHost = new URL(origin).host;
    if (host && originHost !== host) {
      throw new Response(JSON.stringify({ error: "bad_origin" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    throw new Response(JSON.stringify({ error: "bad_origin" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** POST: verify the signed message against the session nonce, set the authed session. */
export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  assertSameOrigin(request);

  const session = await getSession(request.headers.get("Cookie"));
  const sessionNonce = session.get(SIWE_NONCE_KEY) as string | undefined;

  const form = await request.formData();
  const message = String(form.get("message") ?? "");
  const signature = String(form.get("signature") ?? "");

  // verifySiwe throws a 401 Response on any failure (bad sig / nonce mismatch /
  // absent nonce / wrong domain). Let it propagate as the route's thrown response.
  const address = await verifySiwe(message, signature, sessionNonce ?? "");

  // Success: CONSUME the one-time nonce so it cannot be reused (replay guard), and
  // store the authenticated address.
  session.unset(SIWE_NONCE_KEY);
  session.set("address", address);

  return new Response(JSON.stringify({ ok: true, address }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": await commitSession(session),
    },
  });
}

export default function AuthRoute(): React.ReactElement {
  const { nonce } = useLoaderData<typeof loader>() as { nonce: string };
  const fetcher = useFetcher();

  // Full-bleed centered auth card (comp lines 35-64); the SIWE connect->sign flow
  // is unchanged - SiweModal signs in the browser and hands back {message, signature}
  // for this route to POST to the /auth action.
  return (
    <SiweModal
      nonce={nonce}
      busy={fetcher.state !== "idle"}
      onSign={(message, signature) => {
        const form = new FormData();
        form.set("message", message);
        form.set("signature", signature);
        fetcher.submit(form, { method: "post", action: "/auth" });
      }}
    />
  );
}
