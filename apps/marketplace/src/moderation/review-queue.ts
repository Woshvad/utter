// review-queue.ts - the persisted moderation decision log + review queue (MOD-01).
//
// This is a control-plane RECORD, not a UI - the moderation review screen is Phase 6.
// The InMemoryModerationStore is the autonomous test default mirroring the facilitator
// store adapter idiom (services/facilitator/src/stores/memory.ts); the real Postgres
// adapter (SPEC §10 moderation table) implements the SAME ModerationStore interface so
// the publish pipeline swaps adapters by env without change.
import type { ModerationDecision } from "./classifier.js";

/** One recorded moderation decision (decision + reason + timestamp). */
export interface ModerationRecord {
  resourceId: string;
  decision: ModerationDecision;
  reason: string;
  /** ms epoch the decision was made. */
  timestamp: number;
}

/** One ambiguous spec routed to human review. */
export interface ReviewItem {
  resourceId: string;
  prompt: string;
  reason: string;
  timestamp: number;
}

/** The moderation store contract: record every decision + hold the review queue. */
export interface ModerationStore {
  /** Append a moderation decision to the durable log. */
  recordDecision(record: ModerationRecord): Promise<void>;
  /** List every recorded decision (in insertion order). */
  listDecisions(): Promise<ModerationRecord[]>;
  /** Enqueue an ambiguous spec for human review. */
  enqueueReview(item: ReviewItem): Promise<void>;
  /** List the pending review queue (in insertion order). */
  listReviewQueue(): Promise<ReviewItem[]>;
}

/** The in-memory moderation store (autonomous test default). */
export class InMemoryModerationStore implements ModerationStore {
  private readonly decisions: ModerationRecord[] = [];
  private readonly reviewQueue: ReviewItem[] = [];

  async recordDecision(record: ModerationRecord): Promise<void> {
    this.decisions.push({ ...record });
  }

  async listDecisions(): Promise<ModerationRecord[]> {
    return this.decisions.map((d) => ({ ...d }));
  }

  async enqueueReview(item: ReviewItem): Promise<void> {
    this.reviewQueue.push({ ...item });
  }

  async listReviewQueue(): Promise<ReviewItem[]> {
    return this.reviewQueue.map((r) => ({ ...r }));
  }
}
