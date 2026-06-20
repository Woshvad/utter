// @utter/erc8004 - the ERC-8004 on-chain agent identity client (ID-01/02/03). It
// mints a resource's agent identity in the reference IdentityRegistry, reads the
// reputation/validation registries, and exposes the identity used in the A2A
// agent card. It reads the ERC-8004 reference ABIs + addresses from @utter/chain
// (identityAbi/reputationAbi/validationAbi land in Plan 02 post-CREATE2-deploy).
//
// The feature waves append the identity mint/read client + the publish-time
// composition. Task 1 exports the registry client; Task 2 adds publishIdentity.
export {
  createErc8004Client,
  resolveErc8004Addresses,
  HEALTH_VALUE_DECIMALS,
  type Erc8004Client,
  type Erc8004ClientOptions,
  type Erc8004Addresses,
  type RegisterResult,
} from "./client.js";
