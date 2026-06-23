// apiKeyStore.server.ts - the process-wide API-key store instance + the programmatic
// (non-SIWE) auth helper (WR-02 integration wiring).
//
// apikey.server.ts ships the crypto + the ApiKeyStore contract + InMemoryApiKeyStore,
// but nothing instantiated a store or verified a presented key. This module closes
// that gap WITHOUT touching the (sound) crypto:
//   - apiKeyStore: a single process-wide InMemoryApiKeyStore the /keys action mints
//     into and the programmatic auth path verifies against. A real deployment swaps a
//     Postgres-shaped store implementing the same ApiKeyStore interface by env.
//   - requireApiKeyCreator(request): the bearer-key auth path for the programmatic
//     surface. Reads `Authorization: Bearer <raw>`, finds the creator whose stored
//     hash matches (constant-time, via store.verifyFor), and returns that creator -
//     or throws 401. The raw key is never logged.
//
// Raw keys never enter this module's logs (zero console.* in the auth path).
import { FileApiKeyStore, type ApiKeyStore } from "./apikey.server.js";

/**
 * The process-wide API-key store. Now file-backed (FileApiKeyStore) so minted keys
 * survive a restart and are shared across processes that point at the same path; it
 * persists ONLY SHA-256 hashes (never the raw key), writes atomically, and degrades
 * to empty on a corrupt file. The path comes from STUDIO_API_KEYS_PATH (the test
 * suite points this at an OS temp file) or defaults to <app>/.data/api-keys.json. A
 * real deployment can still swap a Postgres-backed ApiKeyStore here; call sites depend
 * only on the interface.
 */
export const apiKeyStore: ApiKeyStore = new FileApiKeyStore();

/**
 * Programmatic (non-SIWE) auth: verify a presented `Authorization: Bearer <raw>` key
 * for the given creator and return the creator address, or throw a 401 Response.
 *
 * The caller supplies WHICH creator the key should belong to (the programmatic
 * surface is per-creator, mirroring the store's per-creator keying). verifyFor does
 * the constant-time hash compare; this helper never logs the raw key.
 */
export async function requireApiKeyCreator(
  request: Request,
  creator: string,
  store: ApiKeyStore = apiKeyStore,
): Promise<string> {
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  const raw = header.startsWith(prefix) ? header.slice(prefix.length) : "";

  if (raw.length > 0 && (await store.verifyFor(creator, raw))) {
    return creator;
  }

  // No valid key. Never echo the presented raw material into the response or a log.
  throw new Response(JSON.stringify({ error: "unauthenticated" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
