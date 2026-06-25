// The data-proxy server bootstrap (PRX-01, PRX-02). Loads `.env.local`, reads the
// HMAC secret + port from the environment, builds the Hono egress proxy via
// createDataProxy, and serves it via @hono/node-server. Fail-fast with an
// operator-friendly message when DATA_PROXY_TOKEN_SECRET is missing (mirrors the
// facilitator's RELAYER_SIGNER_KEYS fail-fast in services/facilitator/src/server.ts).
//
// SECURITY: DATA_PROXY_TOKEN_SECRET is the HS256 secret that verifies the scoped
// resource tokens. It is read from `.env.local` (gitignored) in local runs or the
// container env in Docker, passed straight into createDataProxy, and NEVER logged,
// echoed, or persisted. Only the port is ever surfaced on startup.
//
// Store selection: REDIS_URL is read here for forward-compatibility, but the
// data-proxy package currently exposes only the in-memory adapters (the quota seam
// is additive and left unbound when no quota env is set). The proxy's egress logic
// is identical against either adapter once a Redis-backed store is wired behind the
// same contract; until then the in-memory default stands (the test/dev fallback).
import { config as loadEnv } from "dotenv";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createDataProxy, type DataProxyOpts } from "./index";

loadEnv({ path: ".env.local" });

/** The default port the data-proxy listens on (matches the compose service). */
const DEFAULT_PORT = 8080;

/** The resolved data-proxy runtime config: the port plus the createDataProxy opts. */
export interface ServerConfig {
  /** The port to bind. Defaults to 8080; honors PORT when set. */
  port: number;
  /** The createDataProxy options built from the environment. */
  proxyOpts: DataProxyOpts;
}

/**
 * Build the server config from an environment map (pure; binds no port). Factored
 * out so it is unit-testable without starting a server. Fail-fast on a missing
 * required secret (mirrors the facilitator's buildDepsFromEnv) - NEVER print the
 * secret value, only the fact that it is required.
 *
 * REDIS_URL is optional and read for forward-compatibility; createDataProxy uses
 * its in-memory defaults when no Redis-backed adapter is wired.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const tokenSecret = env.DATA_PROXY_TOKEN_SECRET?.trim();
  if (!tokenSecret) {
    // Operator-friendly fail-fast (mirror the facilitator). The proxy cannot verify
    // a scoped resource token without its HS256 secret. NEVER print the value.
    throw new Error(
      "set DATA_PROXY_TOKEN_SECRET in .env.local (the HS256 secret that verifies scoped resource tokens)",
    );
  }

  const portRaw = env.PORT?.trim();
  const parsedPort = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

  // createDataProxy supplies the in-memory defaults for the allowlist, credential
  // resolver, and DNS lookup. The quota seam stays unbound here (no quota env), so
  // the egress path is the Phase 3 behavior, unchanged. A Redis-backed quota store
  // drops in behind the same contract when REDIS_URL wiring lands.
  const proxyOpts: DataProxyOpts = { tokenSecret };

  return { port, proxyOpts };
}

/** Start the data-proxy HTTP server using config read from the environment. */
export function start(): void {
  const { port, proxyOpts } = configFromEnv();
  const app = createDataProxy(proxyOpts);
  // Log only the port - never the token secret.
  console.log(`data-proxy listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

// Boot when run directly (node src/server.ts), not when imported by a test.
// pathToFileURL normalizes process.argv[1] to the same WHATWG file:// href that
// import.meta.url carries, so the direct-run check fires on Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
