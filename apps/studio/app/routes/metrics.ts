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
import type { LoaderFunctionArgs } from "react-router";
import { Registry } from "@utter/observability";
import { selectAdapter } from "../adapter/select.js";

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
export async function loader(_args: LoaderFunctionArgs): Promise<Response> {
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
