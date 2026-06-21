// select-driver.ts - the env-driven Orchestrator factory.
//
// Copies the selectAdapter idiom (apps/studio/app/adapter/select.ts) verbatim:
// the absent-env branch returns the in-process LocalDriver (the deterministic
// autonomous default), and ONLY `env.ORCHESTRATOR === "nomad"` returns the
// operator-gated NomadDriver. The absent-env-to-local branch is the load-bearing
// autonomous-safety invariant: the suite reaches NO live Nomad host unless the
// operator explicitly opts in (T-08-LIVEGATE).
import type { SandboxRunner } from "@utter/sandbox";
import type { Orchestrator } from "./orchestrator.js";
import { LocalDriver } from "./local-driver.js";
import { NomadDriver } from "./nomad-driver.js";
import { WarmPool } from "./warm-pool.js";
import { IdleReaper } from "./reaper.js";

/**
 * Deps the LocalDriver needs that can't come from `process.env` (the SandboxRunner
 * to schedule through, plus optional warm-pool/reaper overrides). Production
 * wiring injects the gvisor backend; tests inject an in-memory/docker-dev runner.
 */
export interface SelectOrchestratorDeps {
  /** The SandboxRunner the LocalDriver schedules the hardened RunSpec through. */
  runner: SandboxRunner;
  /** Optional warm-pool override (else a default size pool). */
  warmPool?: WarmPool;
  /** Optional reaper override (else a default-TTL reaper). */
  reaper?: IdleReaper;
}

/**
 * Select the orchestrator driver by env. Returns the deterministic LocalDriver by
 * default (when ORCHESTRATOR is unset or anything other than "nomad"); the
 * operator-gated NomadDriver (fail-loud) only when it is explicitly "nomad".
 *
 * The LocalDriver needs an injected SandboxRunner, so `deps` is required for the
 * local path. The NomadDriver needs no deps (it throws before touching anything),
 * so it is returned even when `deps` is absent.
 */
export function selectOrchestrator(
  env: NodeJS.ProcessEnv = process.env,
  deps?: SelectOrchestratorDeps,
): Orchestrator {
  if (env.ORCHESTRATOR === "nomad") {
    return new NomadDriver();
  }
  if (!deps) {
    throw new Error(
      "selectOrchestrator: the LocalDriver requires an injected SandboxRunner " +
        "(deps.runner). Set ORCHESTRATOR=nomad for the operator-gated live driver.",
    );
  }
  return new LocalDriver({
    runner: deps.runner,
    warmPool: deps.warmPool,
    reaper: deps.reaper,
  });
}
