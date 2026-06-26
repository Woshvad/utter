// generated-server-shim.ts - the TRUSTED, platform-owned, gate-less server shim for
// a GENERATED (untrusted) resource handler in the sidecar topology (deploy plane B).
//
// This is what `node server.js` runs inside the UNTRUSTED handler image: the deployer
// esbuilds THIS file (with its `./handler` import resolved to the just-written
// generated handler.ts) into a single self-contained server.js. It mounts the
// generated handler on the resource routes with NO payment gate (the gate lives in
// the separate trusted SIDECAR container, which reserves/settles before reverse-
// proxying validated calls here).
//
// SECURITY: this shim is platform-owned, NOT generated. It holds NO facilitator
// config and NO caller-auth token, and reads only PORT from env. The untrusted
// handler can never see facilitator config or self-settle: the sidecar owns the whole
// payment dance. The shim NEVER logs a config value beyond the bound port. This
// mirrors examples/echo/handler-main.ts (the proven gate-less handler entrypoint).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { handler } from "./handler";

/** The default port the shim listens on (matches the no-install Dockerfile EXPOSE). */
const DEFAULT_PORT = 8080;

/**
 * Build the gate-less Hono app: the generated handler mounted on the resource routes
 * the sidecar reverse-proxies to (/call and /echo), with NO payment gate and NO
 * facilitator config. A plain POST runs the generated handler directly (the sidecar
 * already reserved the cap before proxying here). Mirrors echo's buildHandlerApp.
 */
export function buildShimApp(): Hono {
  const app = new Hono();

  // No gate: the sidecar reserves/settles before proxying here. The generated handler
  // shapes a schema-valid response and never touches money.
  app.post("/call", (c) => handler(c));
  app.post("/echo", (c) => handler(c));

  return app;
}

/** Boot the gate-less generated-handler server on the configured port. */
export function start(): void {
  const port = Number(process.env.PORT ?? String(DEFAULT_PORT));
  const app = buildShimApp();
  // Log only the bound port - never a config value (and there is no secret to leak).
  console.log(`generated handler (gate-less) listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

/**
 * Boot ONLY when this file is the executed entrypoint, NOT when a test imports the
 * factory. The deployer esbuilds this file to a CJS server.js where `require.main` is
 * this module; under the ESM/tsx test runner `require` is undefined, so importing
 * buildShimApp never boots a server. Mirrors handler-main.ts lines 173-177.
 */
declare const require: NodeRequire | undefined;
declare const module: NodeModule | undefined;
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  start();
}
