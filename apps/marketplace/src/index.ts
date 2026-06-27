// @utter/marketplace - the agent-facing marketplace index + A2A card route +
// moderation control plane (MKT-01/02, MOD-01/02).
//
// - The index is a READ-THROUGH PROJECTION (index-store.ts): it caches/surfaces
//   price/reputation/bond for discovery but is NEVER a second source of truth for
//   money or identity - those resolve from the card x402 + the on-chain reads.
// - filterResources (query.ts) is the pure discovery filter agent operators query.
// - createCardApp (card-route.ts) serves the finalized A2A v0.3.0 card at exactly
//   /.well-known/agent-card.json, validateAgentCard-valid.
// - The moderation surface (moderation/*) blocks prohibited-use BEFORE listing
//   (deterministic keyword default + operator-gated model), routes ambiguous specs
//   to a persisted review queue, and composes the no-orphan takedown.
//
// No human UI - Hono routes + JSON only; the Phase 6 screens read this surface.

// --- Index store: the read-through projection + the Postgres-shaped interface ---
export { InMemoryIndexStore } from "./index-store.js";
export type { IndexStore, IndexRecord, ProjectedPricing, ProjectedHealth, Hex } from "./index-store.js";

// --- Card store: the finalized A2A card serving cache (Postgres-shaped interface) ---
export { InMemoryCardStore } from "./card-store.js";
export type { CardStore } from "./card-store.js";

// --- Query: the pure discovery filter ---
export { filterResources } from "./query.js";
export type { FilterCriteria } from "./query.js";

// --- Card route: the A2A card at /.well-known/agent-card.json ---
export { createCardApp } from "./card-route.js";
export type { CardSource, CardAppDeps } from "./card-route.js";

// --- Moderation: classifier + review queue + takedown (MOD-01/02) ---
export {
  classify,
  selectModerator,
  KeywordModerator,
  ModelModerator,
} from "./moderation/classifier.js";
export type {
  Moderator,
  ModerationDecision,
  ClassificationResult,
  ModerationSpec,
} from "./moderation/classifier.js";
export { InMemoryModerationStore } from "./moderation/review-queue.js";
export type {
  ModerationStore,
  ModerationRecord,
  ReviewItem,
} from "./moderation/review-queue.js";
export { takedown } from "./moderation/takedown.js";
export type {
  TakedownDeps,
  TakedownResult,
  TakedownRunner,
  RegistryAdmin,
} from "./moderation/takedown.js";

// --- Publish pipeline: the composed moderation->bond->score->mint->index gate (MKT-03) ---
export {
  createPublishPipeline,
  PublishBlocked,
  PublishUnverified,
  PublishHeldForReview,
} from "./publish.js";
export type {
  PublishPipeline,
  PublishPipelineDeps,
  PublishRequest,
  PublishResult,
  PipelineProber,
  PipelineBondGate,
  PipelineIdentity,
  InitialProbeResult,
  BondReader,
} from "./publish.js";

// --- Test-this-endpoint: the programmatic pay-flow runner (MKT-03/04) ---
export {
  runTestEndpoint,
  liveTestEndpoint,
  RequiresFundedWalletError,
} from "./test-endpoint.js";
export type {
  RunTestEndpointOptions,
  TestEndpointResult,
  CardPayInputs,
  CardFetcher,
  RunnerPublicClient,
  LiveTestEndpointOptions,
} from "./test-endpoint.js";
