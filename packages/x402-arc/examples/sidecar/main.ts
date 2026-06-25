// main.ts - the container entrypoint for the standalone SIDECAR gate-server (C1).
//
// This is what `node server.js` runs inside the TRUSTED sidecar image (the deployer's
// later bundle wave esbuilds this file into a single self-contained server.js, the
// same way it bundles examples/echo/main.ts). It reads its config from env, builds
// the sidecar gate app (the UNCHANGED `requirePayment` gate reverse-proxying to a
// separate gate-less HANDLER_URL container), and listens via @hono/node-server.
//
// SECURITY: this entrypoint runs in the trusted sidecar, NOT the untrusted handler.
// It reads non-secret operational config plus the optional caller-auth token from
// env, holds no wallet key, and reaches the chain only through the facilitator. It
// NEVER logs a config value or the token beyond the bound port and the (non-secret)
// handler host. Only the sidecar talks to the facilitator; the untrusted handler
// container never sees the facilitator, the token, or the buyer payment.
import { serve } from "@hono/node-server";
import { createSidecarGateApp, loadSidecarConfig } from "@utter/x402-arc";

const cfg = loadSidecarConfig();
const app = createSidecarGateApp(cfg);

// Log only the bound port and the non-secret handler host (never the full URL with
// any credentials, never the token, never a pricing/config value).
const handlerHost = new URL(cfg.handlerUrl).host;
console.log(`sidecar gate listening on :${cfg.port} -> handler ${handlerHost}`);

serve({ fetch: app.fetch, port: cfg.port });
