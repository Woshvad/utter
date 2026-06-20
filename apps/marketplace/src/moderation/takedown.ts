// takedown.ts - the composed takedown op (MOD-02).
//
// A takedown must leave NO orphan: a delisted/paused resource's money-handling
// container must be killed, and a killed resource must be delisted + paused. So
// takedown composes all three legs in ONE op (RESEARCH.md:409-415):
//   1. runner.stop(sandboxId)      - SandboxRunner.stop, idempotent sandbox kill
//   2. indexStore.delist(resourceId) - remove from discovery
//   3. registryAdmin pause(resourceId) - ResourceRegistry.pause (operator-gated)
//
// The autonomous proof injects a spy/mock runner + a mock registry admin; the live
// on-chain pause + the live sandbox kill are operator-gated (T-05-06-LIVEPAUSE). The
// reconcile-loop orphan-reap (Phase 3, frozen) backstops a missed leg.
import { registryAbi } from "@utter/chain";
import type { IndexStore, Hex } from "../index-store.js";

/** The minimal SandboxRunner shape this op needs (the stop leg). */
export interface TakedownRunner {
  stop(id: string): Promise<void>;
}

/** The minimal registry admin writer (the pause leg). Mirrors the staking AdminWriter. */
export interface RegistryAdmin {
  address: Hex;
  writeContract(args: {
    address: Hex;
    abi: typeof registryAbi;
    functionName: "pause";
    args: readonly [Hex];
  }): Promise<Hex>;
}

/** The takedown dependencies (all injectable for the autonomous mock-chain proof). */
export interface TakedownDeps {
  runner: TakedownRunner;
  indexStore: IndexStore;
  registryAdmin: RegistryAdmin;
}

/** The takedown outcome - all three legs are reported for the operator audit. */
export interface TakedownResult {
  stopped: boolean;
  delisted: boolean;
  paused: boolean;
  pauseTxHash: Hex;
}

/**
 * Compose the three takedown legs in one op. Each leg is idempotent (stop is
 * idempotent per the SandboxRunner contract; delist is a no-op for an unknown
 * resource; pause is idempotent on-chain), so a partial retry converges. The legs
 * run in sequence stop -> delist -> pause so the container is killed first and the
 * resource is removed from discovery before/with the on-chain pause - a resource is
 * never left listed-but-killed or killed-but-listed.
 */
export async function takedown(
  deps: TakedownDeps,
  resourceId: Hex,
  sandboxId: string,
): Promise<TakedownResult> {
  // 1. Kill the sandbox container (idempotent).
  await deps.runner.stop(sandboxId);

  // 2. Remove from discovery.
  await deps.indexStore.delist(resourceId);

  // 3. Pause on-chain (operator-gated key; mock admin autonomously).
  const pauseTxHash = await deps.registryAdmin.writeContract({
    address: deps.registryAdmin.address,
    abi: registryAbi,
    functionName: "pause",
    args: [resourceId],
  });

  return { stopped: true, delisted: true, paused: true, pauseTxHash };
}
