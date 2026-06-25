// resource-id.ts - the ONE shared helper that turns a resource label into its
// on-chain resourceId. Per RESOURCE-DEPLOY-DESIGN.md §5.5 the deployer's
// registered id, the deployed resource's RESOURCE_ID env, and the studio's
// displayed / payTo id MUST all derive from this single helper + one label
// scheme. If they diverge, debit reverts ResourceInactive or studio links 404.
import { keccak256, toHex, type Hex } from "viem";

// The canonical label scheme is a stable, lowercase, colon-namespaced string of
// the form `utter:<kind>:<slug>` (for example `utter:echo:live-deploy`). The
// resourceId is deterministic in the label and never random, so the SAME label
// string must be used by the deployer (register + quote payTo), by the deployed
// resource's RESOURCE_ID env, and by the studio. Same label in, same id out.
export function resourceIdForLabel(label: string): Hex {
  if (label.trim() === "") {
    // A blank label would silently produce keccak256(toHex("")), a valid-looking
    // but meaningless id shared by every caller that forgot to pass a label.
    // Fail loud instead so a missing label can never collide on-chain.
    throw new Error("resourceIdForLabel: label must be a non-empty string");
  }
  return keccak256(toHex(label));
}

// The echo deploy's label, promoted from the deployer's former inline constant to
// a shared constant so the deployer, the resource env, and the studio all agree
// on the echo id.
export const ECHO_RESOURCE_LABEL = "utter:echo:live-deploy";
