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
//   5. ASSERT the requested host EQUALS the credential's upstream host (CR-01: the
//      container chooses the PATH on its own upstream, never a host swap), RESOLVE
//      + re-check every A/AAAA address against the SSRF block set (CR-02: DNS
//      rebinding / malicious record), enforce the request-size cap, inject the
//      REAL key, and forward via the injectable upstream `fetch` with a timeout
//      and a response-size cap;
//   6. pass the upstream response back to the container.
//
// SECURITY (load-bearing): the container-visible inbound request NEVER carries the
// real key (the passthrough test asserts this). The key is added solely on the
// proxy->upstream leg. There is NO code path that forwards without first passing
// the token verify (step 2), the allowlist (step 3), the host-equality check AND
// the resolved-IP block-check (step 5). The scoped token is also stripped from the
// outbound leg (it is a container<->proxy secret).
//
// CR-01 (host pinning): the outbound forward host is ALWAYS the resolved credential
// upstream host. We additionally REJECT a request whose target host does not equal
// the credential host, so the allowlist check on `target` is no longer decorative —
// a container cannot present an allowlisted host while the forward goes elsewhere,
// and cannot drive an arbitrary host under another resource's key.
//
// CR-02 (rebinding): before forwarding we resolve the upstream host and re-check
// EVERY resolved address against the same block set, then re-validate immediately
// before connect. M7 closes the residual recheck->connect window by PINNING the
// forward to a validated IP via an undici dispatcher whose connect.lookup returns
// only that checked address (TLS SNI/Host preserved, so HTTPS still validates).
// The pin is additive: validation ordering is unchanged; when no pinning transport
// is available the forward proceeds unpinned (the rechecks still apply).
//
// H3 (per-resource allowlist): the egress allowlist is resolved PER-RESOURCE from
// the token-verified resourceId (mirroring the credential resolver), never from a
// container-supplied value, so one tenant's allowlist is not every tenant's on a
// shared proxy. The single global `allowlist` opt is kept (wrapped as a resolver)
// for dev/back-compat + the trusted echo path.
import { Hono } from "hono";
import { normalizeAndCheckHost, resolveAndCheckHost, type DnsLookupAll } from "./allowlist";
import {
  resolveUpstreamCredential,
  type CredentialResolver,
} from "./credentials";
import {
  globalAllowlistResolver,
  type AllowlistResolver,
} from "./allowlist-resolver";
import {
  defaultPinningDispatcherFactory,
  type PinningDispatcherFactory,
} from "./pin-dispatcher";
import { verifyResourceToken } from "./token";
import type { QuotaStore, QuotaBudget } from "./quota";

/** A `fetch`-like seam so tests inject an upstream spy (mirrors the gate's fetcher). */
export type FetchLike = typeof fetch;

/** Header the container presents the scoped token in. */
const TOKEN_HEADER = "x-resource-token";
/** Header binding the request to a resource (the token `aud` is checked against it). */
const RESOURCE_HEADER = "x-resource-id";
/** Header carrying the requested upstream URL the container wants to reach. */
const UPSTREAM_HEADER = "x-upstream-url";

/** Hard request-body cap (bytes). Reject an oversize inbound body before forwarding. */
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
/** Hard response-body cap (bytes). Reject an oversize upstream body before relaying. */
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
/** Egress timeout (seconds): abort a slow upstream so it cannot hold the proxy open. */
const DEFAULT_EGRESS_TIMEOUT_SECONDS = 30;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Options for {@link createDataProxy}. */
export interface DataProxyOpts {
  /** The HS256 secret (DATA_PROXY_TOKEN_SECRET). Stays on the proxy; verifies tokens. */
  tokenSecret: string;
  /**
   * A SINGLE global upstream host allowlist (default-deny), applied to every
   * resource. Kept for dev/back-compat + the trusted echo path; internally wrapped
   * as a resolver that returns this list for all resources. For a multi-tenant
   * proxy use {@link DataProxyOpts.allowlistResolver} so each resource is checked
   * against ITS OWN allowlist (H3). When both are given, the resolver wins.
   */
  allowlist?: readonly string[];
  /**
   * H3 per-resource allowlist resolver: given the VERIFIED resourceId (the token
   * `aud`, never a container-supplied value), return that resource's egress
   * allowlist. This closes the cross-tenant leak where one tenant's allowlist was
   * every tenant's. When omitted, the proxy wraps {@link DataProxyOpts.allowlist}
   * as a resolver (or default-deny when that is also omitted). Resolution mirrors
   * the per-resource {@link DataProxyOpts.resolveCredential} seam.
   */
  allowlistResolver?: AllowlistResolver;
  /** The injectable upstream fetch (default global `fetch`; tests inject a spy). */
  upstreamFetch?: FetchLike;
  /** The server-side credential resolver (default {@link resolveUpstreamCredential}). */
  resolveCredential?: CredentialResolver;
  /**
   * Injectable DNS resolver for the resolved-IP SSRF re-check (CR-02). Defaults to
   * Node `dns.lookup({all:true})`; tests stub it to simulate a rebinding record.
   */
  dnsLookup?: DnsLookupAll;
  /**
   * M7 socket-pinning dispatcher factory. After the resolved-IP SSRF recheck
   * produces the validated addresses, the proxy asks this factory for a dispatcher
   * that pins the forward connect to one of those already-validated IPs (closing
   * the recheck->connect DNS-rebind window). The returned dispatcher is passed as
   * the `dispatcher` on the forward `fetch`. Defaults to
   * {@link defaultPinningDispatcherFactory}, which builds a real undici Agent when
   * undici is available and otherwise returns `undefined` (no pin, today's
   * behavior). Tests inject a fake factory to assert the pin holds.
   */
  pinningDispatcherFactory?: PinningDispatcherFactory;
  /** Max inbound request body bytes (default MAX_REQUEST_BYTES env or 1 MiB). */
  maxRequestBytes?: number;
  /** Max upstream response body bytes (default MAX_RESPONSE_BYTES env or 1 MiB). */
  maxResponseBytes?: number;
  /** Egress timeout in seconds (default RESOURCE_TIMEOUT_SECONDS env or 30s). */
  egressTimeoutSeconds?: number;
  /**
   * PRX-03 quota counter (per-resource call/byte accounting). When BOTH this and
   * {@link DataProxyOpts.quotaBudget} are provided, the /proxy path increments the
   * resource's counter AFTER token-verify + allowlist and BEFORE inject+forward, and
   * returns 429 fail-closed once usage exceeds the budget. Omit both to leave the
   * egress path unbounded (the Phase 3 behavior, unchanged). The counter is plain
   * call/byte accounting - never a USDC amount, no decimals literal - and the markup
   * is attributable to the platform cut, not a double-charge of the buyer.
   */
  quotaStore?: QuotaStore;
  /** PRX-03 per-resource ceiling. Required alongside {@link DataProxyOpts.quotaStore}. */
  quotaBudget?: QuotaBudget;
}

/**
 * Build the Hono data-proxy app. A single `POST /proxy` route runs the ordered
 * verify -> allowlist -> resolve -> host-pin -> resolved-IP-check -> inject ->
 * forward flow. Mount this behind the netns firewall (Plan 02) so it is the only
 * route out of the sandbox.
 */
export function createDataProxy(opts: DataProxyOpts) {
  const upstreamFetch: FetchLike = opts.upstreamFetch ?? (globalThis.fetch as FetchLike);
  const resolveCredential: CredentialResolver =
    opts.resolveCredential ?? resolveUpstreamCredential;
  // H3: resolve the allowlist PER-RESOURCE from the verified resourceId. The
  // explicit resolver wins; otherwise the single global `allowlist` is wrapped as
  // a resolver returning it for every resource (dev/back-compat), or default-deny
  // when neither is supplied. The container NEVER influences which list applies -
  // the key is the token-verified resourceId.
  const resolveAllowlist: AllowlistResolver =
    opts.allowlistResolver ?? globalAllowlistResolver(opts.allowlist);
  const dnsLookup = opts.dnsLookup;
  const pinningDispatcherFactory: PinningDispatcherFactory =
    opts.pinningDispatcherFactory ?? defaultPinningDispatcherFactory;
  const maxRequestBytes =
    opts.maxRequestBytes ?? envInt("MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES);
  const maxResponseBytes =
    opts.maxResponseBytes ?? envInt("MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES);
  const egressTimeoutSeconds =
    opts.egressTimeoutSeconds ??
    envInt("RESOURCE_TIMEOUT_SECONDS", DEFAULT_EGRESS_TIMEOUT_SECONDS);
  const quotaStore = opts.quotaStore;
  const quotaBudget = opts.quotaBudget;

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

    // (2.5) H3: resolve THIS resource's egress allowlist from the VERIFIED
    // resourceId. `verifyResourceToken` already proved the token `aud` equals
    // `resourceId`, so a token minted for A presenting `x-resource-id: B` was
    // rejected at step 2 with a 401 and never reaches here - a resource can only
    // ever obtain its OWN allowlist, never a sibling tenant's (the cross-tenant
    // leak H3 closes). An empty resolved list is default-deny (no host passes).
    const allowlist = resolveAllowlist(resourceId);

    // (3) Allowlist + SSRF-normalize the requested upstream. ONLY after the token
    // is verified. A non-allowlisted / private / metadata target -> 403, no forward.
    if (!target) {
      return c.json({ error: "missing_upstream_url" }, 403);
    }
    const hostCheck = normalizeAndCheckHost(target, allowlist);
    if (!hostCheck.ok) {
      return c.json({ error: "upstream_not_allowlisted" }, 403);
    }

    // (3.5) PRX-03 QUOTA GATE. ONLY after the token-verify (step 2) and the allowlist
    // (step 3), and BEFORE the credential resolution + inject + forward (steps 4-5).
    // A blocked (401/403) request never reaches here, so it never consumes quota. The
    // counter is per-resource call/byte accounting (never money); over the budget we
    // return 429 FAIL-CLOSED so the over-quota call never forwards upstream. The
    // egress/SSRF/key-injection logic below is untouched - this is an additive gate.
    if (quotaStore && quotaBudget) {
      // Count the inbound body bytes for the byte budget. Read once here; the body is
      // re-read below for forwarding (Hono buffers the request body, so a second read
      // is safe). 0 for a bodyless method.
      const method = c.req.method;
      const hasInboundBody = method !== "GET" && method !== "HEAD";
      const inboundBytes = hasInboundBody
        ? (await c.req.arrayBuffer()).byteLength
        : 0;
      // WR-03: EXPLICIT fail-closed. If the counter store throws (e.g. the Redis
      // adapter is unreachable), DENY the request with an explicit 429 - never rely on
      // a framework 500 default, and never "degrade gracefully" by skipping the
      // counter (that would silently flip fail-OPEN). The over-quota branch below is
      // the other fail-closed leg; both deny, neither forwards upstream.
      let usage: QuotaBudget;
      try {
        usage = await quotaStore.increment(resourceId, {
          calls: 1,
          bytes: inboundBytes,
        });
      } catch {
        return c.json({ error: "quota_unavailable" }, 429);
      }
      if (usage.calls > quotaBudget.calls || usage.bytes > quotaBudget.bytes) {
        return c.json({ error: "quota_exceeded" }, 429);
      }
    }

    // (4) Resolve the REAL upstream credential SERVER-SIDE. A resource with no
    // mapped credential fails closed; never forward without a credential.
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

    // (5) Build the OUTBOUND request. The forward host is ALWAYS the resolved
    // credential upstream host. CR-01: the requested host MUST EQUAL the credential
    // host, otherwise the allowlist check on `target` would be decorative (the
    // container could present an allowlisted host while we forward to the credential
    // base under the real key). Reject a host mismatch — the container chooses only
    // the PATH/QUERY on its OWN upstream, never a host swap.
    const requested = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`,
    );
    const upstreamUrl = new URL(cred.upstreamBaseUrl);
    if (normalizeHostname(requested.hostname) !== normalizeHostname(upstreamUrl.hostname)) {
      return c.json({ error: "upstream_host_mismatch" }, 403);
    }
    upstreamUrl.pathname = requested.pathname;
    upstreamUrl.search = requested.search;

    // CR-02: resolve the upstream host and re-check EVERY resolved A/AAAA address
    // against the SSRF block set, so an allowlisted record that resolves to a
    // private/metadata address (DNS rebinding or a malicious allowlisted record) is
    // rejected before we ever connect.
    const resolved = await resolveAndCheckHost(upstreamUrl.hostname, allowlist, dnsLookup);
    if (!resolved.ok) {
      return c.json({ error: "upstream_resolves_to_blocked" }, 403);
    }

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
    // WR-01: hard-reject an oversize inbound body before forwarding upstream.
    if (body && body.byteLength > maxRequestBytes) {
      return c.json({ error: "request_too_large" }, 413);
    }

    // CR-02 (TOCTOU tighten): re-validate the resolved host immediately before the
    // connect, then PIN (M7) the forward to one of these validated addresses.
    const recheck = await resolveAndCheckHost(upstreamUrl.hostname, allowlist, dnsLookup);
    if (!recheck.ok) {
      return c.json({ error: "upstream_resolves_to_blocked" }, 403);
    }

    // M7: close the recheck->connect DNS-rebind window by pinning the forward
    // connection to an already-validated IP. The dispatcher's connect.lookup
    // returns ONLY a checked address for this host, so the connect cannot be
    // redirected to a freshly-rebound (blocked) IP. TLS SNI/Host are preserved
    // (the dispatcher connects by IP but the request URL keeps the hostname), so
    // HTTPS certificate validation is unchanged. Additive: the validation ordering
    // above is untouched; the pin only constrains the connect target. When no
    // pinning transport is available the factory returns undefined and the forward
    // proceeds unpinned (today's behavior, with the rechecks still in force).
    const pinDispatcher = await pinningDispatcherFactory(
      upstreamUrl.hostname,
      recheck.addresses ?? [],
    );

    // WR-01: bound the egress with a timeout so a slow upstream cannot hold the
    // proxy connection open indefinitely (DoS from inside the sandbox).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), egressTimeoutSeconds * 1000);

    // The forward init. `dispatcher` is an undici extension Node's global `fetch`
    // honors; it is omitted entirely when no pin is available so a plain fetch
    // (or an injected test spy) sees an unchanged init shape. Typed as a loose
    // record for the optional `dispatcher` key (the lib's RequestInit.dispatcher is
    // the concrete undici Dispatcher, which this module deliberately does not type
    // against) and passed through to the fetch seam.
    // H1: never auto-follow a redirect. Without this, a 3xx from an allowlisted
    // upstream is followed with fresh DNS to the Location target, bypassing every
    // guard above (allowlist, block-set, host-equality, resolve-and-recheck, the
    // M7 socket pin) because those run only on the first hop, and the injected
    // upstream bearer rides along to an attacker-chosen host (cloud metadata,
    // loopback, RFC1918). With "manual", fetch returns the 3xx itself; the relay
    // below passes that status and body straight back to the caller. To reach a
    // redirect target the untrusted caller must re-request through /proxy, which
    // re-runs the full allowlist on the new host.
    const forwardInit: Record<string, unknown> = {
      method,
      headers: outHeaders,
      body,
      signal: ac.signal,
      redirect: "manual",
    };
    if (pinDispatcher !== undefined) forwardInit.dispatcher = pinDispatcher;

    let upstreamRes: Response;
    try {
      upstreamRes = await upstreamFetch(
        upstreamUrl.toString(),
        forwardInit as RequestInit,
      );
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return c.json({ error: "upstream_timeout" }, 504);
      }
      return c.json({ error: "upstream_unreachable" }, 502);
    }
    clearTimeout(timer);

    // (6) Pass the upstream response back to the container. Strip hop-by-hop / any
    // credential-bearing headers; relay the status + body + content-type only.
    const passHeaders = new Headers();
    const upstreamCt = upstreamRes.headers.get("content-type");
    if (upstreamCt) passHeaders.set("content-type", upstreamCt);
    const responseBody = await upstreamRes.arrayBuffer();
    // WR-01: hard-reject an oversize upstream response before relaying it.
    if (responseBody.byteLength > maxResponseBytes) {
      return c.json({ error: "response_too_large" }, 502);
    }

    // IN-02: meter the RESPONSE bytes (the dominant upstream cost) into the per-resource
    // counter so byte usage reflects what was actually relayed, not just the inbound
    // request. This is a usage meter for the platform-cut markup (plain byte accounting,
    // never a USDC amount, no decimals literal); the response already passed the egress
    // path, so a counter failure here is best-effort (it must not corrupt the buyer's
    // already-fetched response) - the request-time increment above is the fail-closed
    // budget gate.
    if (quotaStore && quotaBudget) {
      try {
        await quotaStore.increment(resourceId, { calls: 0, bytes: responseBody.byteLength });
      } catch {
        // Best-effort post-relay metering: the response is already authorized and
        // fetched. The fail-closed budget decision was made at request time above.
      }
    }

    return new Response(responseBody, {
      status: upstreamRes.status,
      headers: passHeaders,
    });
  });

  return app;
}

/** Lowercase + strip a single trailing dot for host equality comparison. */
function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}
