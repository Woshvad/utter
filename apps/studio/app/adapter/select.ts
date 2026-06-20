// select.ts - the env-driven StudioDataAdapter factory.
//
// Mirrors selectGenerator (ai-runtime/src/generator.ts:37-45) and selectProber
// (ai-scorer/src/prober.ts:134-142). The load-bearing invariant is the
// `env.STUDIO_DATA_ADAPTER !== "live" -> FixtureAdapter` default: the whole
// autonomous suite reaches NO network/chain/model path unless the operator
// explicitly sets STUDIO_DATA_ADAPTER=live. The LiveAdapter is fail-loud.
import type { StudioDataAdapter } from "./types.js";
import { FixtureAdapter } from "./fixture.js";
import { LiveAdapter } from "./live.js";

/**
 * Select the Studio data adapter by env. Returns the deterministic FixtureAdapter
 * by default (when STUDIO_DATA_ADAPTER is unset or anything other than "live"),
 * and the operator-gated LiveAdapter only when it is explicitly "live". The
 * absent-env-to-fixture branch is what keeps the autonomous suite safe.
 */
export function selectAdapter(
  env: NodeJS.ProcessEnv = process.env,
): StudioDataAdapter {
  if (env.STUDIO_DATA_ADAPTER === "live") {
    return new LiveAdapter();
  }
  return new FixtureAdapter();
}
