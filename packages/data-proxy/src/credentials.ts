// credentials.ts — server-side token -> resource -> upstream-credential mapping
// (SBX-03, PRX-01; RESEARCH Pattern 3 "the proxy maps resourceId ->
// {upstreamBaseUrl, realApiKey} server-side").
//
// SECURITY (load-bearing): this credential table lives ONLY on the proxy. The
// container NEVER receives `realApiKey` — it holds only the short-lived scoped
// token (token.ts). The proxy verifies the token, resolves the real credential
// HERE server-side, and injects it solely on the proxy->upstream leg. The
// `realApiKey` must never be placed in the token payload nor echoed back to the
// container-visible request (the passthrough test asserts this invariant).
//
// The map below is a DEV FIXTURE for tests + local wiring. In production the
// credential source is a server-side secret store (env / secrets manager keyed
// by resourceId); the resolver signature stays identical so the proxy code does
// not change when the backend is swapped.

/** A server-side upstream credential. NEVER leaves the proxy. */
export interface UpstreamCredential {
  /** The allowlisted upstream base URL the proxy forwards to. */
  upstreamBaseUrl: string;
  /** The real upstream API key, injected only on the proxy->upstream leg. */
  realApiKey: string;
}

/**
 * The dev/test credential fixture: resourceId -> server-side upstream credential.
 * Replaced by a secrets-backed source in production via {@link CredentialResolver}.
 */
const DEV_CREDENTIAL_TABLE: Readonly<Record<string, UpstreamCredential>> = {
  "resource-aaaa-1111": {
    upstreamBaseUrl: "https://api.openai.com",
    realApiKey: "sk-real-upstream-key-AAAA-server-side-only",
  },
  "resource-bbbb-2222": {
    upstreamBaseUrl: "https://api.weather.example.com",
    realApiKey: "wk-real-upstream-key-BBBB-server-side-only",
  },
};

/**
 * Resolve the server-side upstream credential for `resourceId`.
 *
 * Throws for an unknown resource — there is NO fallback / default credential (a
 * miss must fail closed, never leak a shared key). The returned `realApiKey` is
 * for server-side injection only and must never reach the container.
 */
export function resolveUpstreamCredential(resourceId: string): UpstreamCredential {
  const cred = DEV_CREDENTIAL_TABLE[resourceId];
  if (!cred) {
    throw new Error(`no upstream credential mapped for resource: ${resourceId}`);
  }
  return cred;
}

/**
 * The resolver seam: production injects a secrets-backed resolver with the same
 * shape; tests + local wiring default to {@link resolveUpstreamCredential}.
 */
export type CredentialResolver = (resourceId: string) => UpstreamCredential;
