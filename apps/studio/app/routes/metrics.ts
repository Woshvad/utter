// metrics.ts - the OBS-01 /metrics resource route (loader only, no component).
//
// Returns the @utter/observability Registry rendered as Prometheus exposition text
// (Plan 03). The autonomous path seeds the registry with CLEARLY-fixture deterministic
// values and renders with a runtime decimals read through the adapter (never a 1e6/6
// literal in the render). The live path injects the real shared registry the
// facilitator/deployer/scorer tap; the live chain-balance gauges (escrow/relayer
// USDC) are operator-gated - the gauge is exposed here, the live on-chain read is the
// deferred half (Pitfall 8 / T-06-FAKEMETRICS). We never fake live numbers: the test
// asserts the registered metric NAMES + the text format, not invented values.
import { timingSafeEqual } from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import { Registry } from "@utter/observability";
import { selectAdapter } from "../adapter/select.js";
import { getAuthAddress } from "../auth/session.server.js";

/**
 * Access gate for /metrics (WR-03). The Prometheus exposition leaks the full
 * money-path posture (gross/creator/platform/relayer USDC, settle failures), so the
 * route is fail-closed: a caller is authorized iff EITHER
 *   - it carries a valid creator session (an operator browsing in-app), OR
 *   - it presents the operator metrics bearer token (METRICS_TOKEN, .env.local only)
 *     in `Authorization: Bearer <token>`, compared CONSTANT-TIME.
 * Anything else gets 401. METRICS_TOKEN is never logged and ships EMPTY in
 * .env.example; when it is unset the bearer path is disabled entirely (a Prometheus
 * scraper must be configured with a real token), so an empty env can never authorize.
 */
async function isMetricsAuthorized(request: Request): Promise<boolean> {
  // 1. A valid creator session authorizes (operator browsing the metrics in-app).
  const address = await getAuthAddress(request);
  if (address) return true;

  // 2. Otherwise require the operator bearer token, constant-time compared.
  const configured = process.env.METRICS_TOKEN;
  if (!configured || configured.length === 0) return false; // bearer path disabled

  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);

  // timingSafeEqual needs equal-length buffers; a length mismatch is a definite
  // non-match (and avoids a length side channel / a throw on differing lengths).
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build the registry to render. In the autonomous (fixture) path this seeds the
 * registry with deterministic, clearly-fixture values so the exposition format is
 * exercised end-to-end without faking live numbers. The live adapter would instead
 * return the shared registry the services have been taping; the chain-balance gauges
 * stay 0n until the operator-gated on-chain read is wired.
 */
function buildRegistry(backend: "fixture" | "live"): Registry {
  const registry = new Registry();
  if (backend === "fixture") {
    // Deterministic fixture seed (counts are plain numbers; USDC gauges are base
    // units - the decimals format is applied at render from the runtime read).
    registry.callsTotal.inc(128);
    registry.callsPerMin.set(4);
    registry.settleLatency.observe(120);
    registry.reservationsOpen.set(2);
    registry.reservationsReleased.inc(126);
    registry.healthScore.set(0.98);
    registry.grossUsdc.set(1280000n);
    registry.creatorUsdc.set(896000n);
    registry.platformUsdc.set(384000n);
    registry.refundUsdc.set(20000n);
    // escrow/relayer USDC remain operator-gated (0n) - never faked.
  }
  return registry;
}

/**
 * The /metrics loader: render the registry as Prometheus text with the runtime USDC
 * decimals read through the adapter (no literal). Content-Type is the Prometheus
 * exposition version the registry emits.
 */
export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  // Fail-closed access gate (WR-03): operator session OR the metrics bearer token.
  // Unauthenticated callers get 401 - the money-path metric set is never world-readable.
  if (!(await isMetricsAuthorized(request))) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const adapter = selectAdapter(process.env);

  // Runtime money scale read through the adapter (no 6/1e6 literal in the render).
  const { decimals } = await adapter.getEscrowBalance(
    "0x0000000000000000000000000000000000000000",
  );

  const registry = buildRegistry(adapter.backend);
  const body = registry.render(decimals);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4",
      "Cache-Control": "no-cache",
    },
  });
}
