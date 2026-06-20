// proxy.ts — the Hono data-proxy service (PRX-01, PRX-02; RESEARCH Pattern 3
// "validate scoped token (aud,exp) -> allowlist host check -> map token->resource
// ->upstream creds server-side -> inject real key -> forward").
//
// This is the ONLY permitted egress from a sandboxed resource. The request flow
// is LOAD-BEARING and ordered (mirrors the gate's ordered escrow flow):
//   1. read the scoped token + requested upstream from the inbound (container) req;
//   2. verifyResourceToken (aud=resourceId + exp + HS256) -> 401 on failure;
//   3. normalizeAndCheckHost + allowlist on the requested upstream -> 403 on failure;
//   4. resolveUpstreamCredential(resourceId) SERVER-SIDE;
//   5. inject the REAL key into the OUTBOUND request (proxy->upstream leg ONLY) and
//      forward via the injectable upstream `fetch`;
//   6. pass the upstream response back to the container.
//
// SECURITY (load-bearing): the container-visible inbound request NEVER carries the
// real key (the passthrough test asserts this). The key is added solely on the
// proxy->upstream leg. There is NO code path that forwards without first passing
// BOTH the token verify (step 2) AND the allowlist (step 3) — verify precedes the
// allowlist so a bad token short-circuits before any host/cred work. The scoped
// token is also stripped from the outbound leg (it is a container<->proxy secret).
import { Hono } from "hono";
import { normalizeAndCheckHost } from "./allowlist";
import {
  resolveUpstreamCredential,
  type CredentialResolver,
} from "./credentials";
import { verifyResourceToken } from "./token";

/** A `fetch`-like seam so tests inject an upstream spy (mirrors the gate's fetcher). */
export type FetchLike = typeof fetch;

/** Header the container presents the scoped token in. */
const TOKEN_HEADER = "x-resource-token";
/** Header binding the request to a resource (the token `aud` is checked against it). */
const RESOURCE_HEADER = "x-resource-id";
/** Header carrying the requested upstream URL the container wants to reach. */
const UPSTREAM_HEADER = "x-upstream-url";

/** Options for {@link createDataProxy}. */
export interface DataProxyOpts {
  /** The HS256 secret (DATA_PROXY_TOKEN_SECRET). Stays on the proxy; verifies tokens. */
  tokenSecret: string;
  /** The per-deployment upstream host allowlist (default-deny). */
  allowlist?: readonly string[];
  /** The injectable upstream fetch (default global `fetch`; tests inject a spy). */
  upstreamFetch?: FetchLike;
  /** The server-side credential resolver (default {@link resolveUpstreamCredential}). */
  resolveCredential?: CredentialResolver;
}

/**
 * Build the Hono data-proxy app. A single `POST /proxy` route runs the ordered
 * verify -> allowlist -> resolve -> inject -> forward flow. Mount this behind the
 * netns firewall (Plan 02) so it is the only route out of the sandbox.
 */
export function createDataProxy(opts: DataProxyOpts) {
  const upstreamFetch: FetchLike = opts.upstreamFetch ?? (globalThis.fetch as FetchLike);
  const resolveCredential: CredentialResolver =
    opts.resolveCredential ?? resolveUpstreamCredential;
  const allowlist = opts.allowlist;

  const app = new Hono();

  app.post("/proxy", async (c) => {
    // (1) Read the scoped token + resource + requested upstream from the inbound
    // (container) request. The container holds ONLY the token — never a real key.
    const token = c.req.header(TOKEN_HEADER);
    const resourceId = c.req.header(RESOURCE_HEADER);
    const target = c.req.header(UPSTREAM_HEADER);

    // (2) Verify the scoped token BEFORE anything else. A missing/blank resourceId
    // or token, a wrong audience, an expired token, or a bad signature -> 401 with
    // NO forward and NO credential resolution.
    if (!token || !resourceId) {
      return c.json({ error: "missing_resource_token" }, 401);
    }
    if (!verifyResourceToken(token, resourceId, opts.tokenSecret)) {
      return c.json({ error: "invalid_resource_token" }, 401);
    }

    // (3) Allowlist + SSRF-normalize the requested upstream. ONLY after the token
    // is verified. A non-allowlisted / private / metadata target -> 403, no forward.
    if (!target) {
      return c.json({ error: "missing_upstream_url" }, 403);
    }
    const hostCheck = normalizeAndCheckHost(target, allowlist);
    if (!hostCheck.ok) {
      return c.json({ error: "upstream_not_allowlisted" }, 403);
    }

    // (4) Resolve the REAL upstream credential SERVER-SIDE. A resource with no
    // mapped credential fails closed (401-equivalent at the resource layer); never
    // forward without a credential.
    let cred: { upstreamBaseUrl: string; realApiKey: string };
    try {
      cred = resolveCredential(resourceId);
    } catch {
      return c.json({ error: "no_upstream_credential" }, 403);
    }

    // Defense-in-depth: the resolved upstream base must itself be allowlisted, so a
    // mis-mapped credential cannot redirect the forward to a non-allowlisted host.
    const baseCheck = normalizeAndCheckHost(cred.upstreamBaseUrl, allowlist);
    if (!baseCheck.ok) {
      return c.json({ error: "upstream_not_allowlisted" }, 403);
    }

    // (5) Build the OUTBOUND request. Compose the resolved upstream base + the
    // requested path/query, copy the body + safe headers, STRIP the container<->proxy
    // token, and inject the REAL key ONLY here (the proxy->upstream leg). The real
    // key is NEVER on the inbound container-visible request.
    const requested = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`,
    );
    const upstreamUrl = new URL(cred.upstreamBaseUrl);
    upstreamUrl.pathname = requested.pathname;
    upstreamUrl.search = requested.search;

    const outHeaders = new Headers();
    // Forward only a safe content-type; never echo the scoped token or any
    // container-supplied authorization upstream.
    const contentType = c.req.header("content-type");
    if (contentType) outHeaders.set("content-type", contentType);
    // Inject the real upstream credential SERVER-SIDE (proxy->upstream leg only).
    outHeaders.set("authorization", `Bearer ${cred.realApiKey}`);

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await c.req.arrayBuffer() : undefined;

    const upstreamRes = await upstreamFetch(upstreamUrl.toString(), {
      method,
      headers: outHeaders,
      body,
    });

    // (6) Pass the upstream response back to the container. Strip hop-by-hop / any
    // credential-bearing headers; relay the status + body + content-type only.
    const passHeaders = new Headers();
    const upstreamCt = upstreamRes.headers.get("content-type");
    if (upstreamCt) passHeaders.set("content-type", upstreamCt);
    const responseBody = await upstreamRes.arrayBuffer();
    return new Response(responseBody, {
      status: upstreamRes.status,
      headers: passHeaders,
    });
  });

  return app;
}
