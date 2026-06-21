// nomad-driver.ts - the operator-gated live orchestrator stub.
//
// Mirrors packages/buyer-sdk/src/transport.ts RequiresLiveBuyerError +
// createLiveTransport (the fail-loud gated-error shape): a readonly `code`
// discriminant + a message naming the missing operator provisioning. Every
// method throws RequiresLiveOrchestrator so the autonomous suite NEVER reaches a
// live Nomad host (T-08-LIVEGATE). The live multi-host scheduling half is
// provisioned by the operator (a Nomad cluster + .env.local keys); until then
// the in-process LocalDriver is the only autonomously-provable surface.
import type { RunSpec, RunHandle } from "@utter/sandbox";
import type { Orchestrator } from "./orchestrator.js";

/**
 * The operator-gated fail-loud error for the live Nomad orchestrator. Mirrors
 * RequiresLiveBuyerError (transport.ts:77-87): a readonly `code` discriminant +
 * a message naming the missing Nomad host + `.env.local` provisioning. The live
 * orchestrator is NEVER run by the autonomous suite.
 */
export class RequiresLiveOrchestrator extends Error {
  readonly code = "requiresLiveOrchestrator" as const;
  constructor() {
    super(
      "The live Nomad orchestrator requires a provisioned NOMAD_ADDR cluster " +
        "(+ NOMAD_TOKEN) and gVisor-capable hosts in .env.local. Live multi-host " +
        "scheduling places untrusted handlers on real isolation hosts; it is " +
        "operator-gated and not run autonomously. Use the in-process LocalDriver " +
        "(unset ORCHESTRATOR) for the autonomous path.",
    );
    this.name = "RequiresLiveOrchestrator";
  }
}

/**
 * The live Nomad orchestrator stub. Until the operator provisions the cluster,
 * every method throws RequiresLiveOrchestrator (fail-loud). The `driver`
 * discriminant is still "nomad" so selectOrchestrator + diagnostics can report
 * which driver was selected without invoking a live path.
 */
export class NomadDriver implements Orchestrator {
  readonly driver = "nomad" as const;

  async schedule(_resourceId: string, _spec: RunSpec): Promise<RunHandle> {
    throw new RequiresLiveOrchestrator();
  }

  async reap(_now: number): Promise<void> {
    throw new RequiresLiveOrchestrator();
  }
}
