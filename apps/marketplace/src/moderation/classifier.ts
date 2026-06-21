// classifier.ts - the pre-publish moderation classifier (MOD-01).
//
// A deterministic keyword/rule classifier is the autonomous test DEFAULT: it blocks
// prohibited-use endpoints (abuse scrapers, phishing, malware, sanctioned-data per
// SPEC §13) BEFORE listing, allows clean specs, and routes ambiguous specs to a
// persisted review queue. selectModerator(env) mirrors selectGenerator
// (packages/ai-runtime/src/generator.ts): the keyword backend by default and only
// when ANTHROPIC_API_KEY is absent or MODERATION_BACKEND is forced to keyword; the
// model backend (operator-gated) otherwise.
//
// The classifier is a control-plane decision, not a UI - the review UI is Phase 6.
import type { ModerationStore } from "./review-queue.js";

/** The three moderation outcomes. */
export type ModerationDecision = "allow" | "block" | "review";

/** A classification result + the human-readable reason. */
export interface ClassificationResult {
  decision: ModerationDecision;
  reason: string;
}

/** The spec to classify (the creator's plain-English prompt + optional fields). */
export interface ModerationSpec {
  prompt: string;
  category?: string;
}

// Prohibited-use rules (SPEC §13): a hit on any BLOCK pattern blocks the listing.
// These are deliberately specific phrases/word-pairs so a benign mention of a word
// (e.g. "weather data") does not over-block; the REVIEW patterns catch the gray area.
const BLOCK_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bransomware\b|\bmalware\b|\bspyware\b|\bkeylogger\b|\bbotnet\b/i, reason: "malware" },
  { pattern: /\bphishing\b|steal(s|ing)?\s+(bank\s+)?(passwords?|credentials?)|credential[- ]?stuffing/i, reason: "phishing/credential-theft" },
  { pattern: /scrape[^.]*\bpersonal\s+data\b|harvest[^.]*\b(emails?|personal\s+data)\b|\bdoxx?ing\b/i, reason: "abuse-scraper/personal-data" },
  { pattern: /\bsanctioned\b|\bweapons?\s+export\b|\bchild\s+(sexual|abuse)\b|\bcsam\b/i, reason: "sanctioned/prohibited-data" },
];

// Ambiguous patterns -> route to human review (not an automatic allow or block).
const REVIEW_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bscrap(e|ing)\b|\bcrawl(er|ing)?\b|\bharvest\b/i, reason: "scraping (needs review for source/consent)" },
  { pattern: /\bpersonal\b|\bbiometric\b|\bsurveillance\b/i, reason: "personal/sensitive data (needs review)" },
];

/**
 * Classify a spec deterministically. BLOCK wins over REVIEW wins over ALLOW (the
 * most restrictive matching rule decides). Pure: no I/O.
 */
export function classify(spec: ModerationSpec): ClassificationResult {
  const text = spec.prompt ?? "";
  for (const { pattern, reason } of BLOCK_PATTERNS) {
    if (pattern.test(text)) return { decision: "block", reason };
  }
  for (const { pattern, reason } of REVIEW_PATTERNS) {
    if (pattern.test(text)) return { decision: "review", reason };
  }
  return { decision: "allow", reason: "no prohibited-use or ambiguous pattern matched" };
}

/** A moderator: classify + persist the decision and (for review) enqueue. */
export interface Moderator {
  /** Which backend this moderator is - the deterministic-default discriminator. */
  readonly backend: "keyword" | "model";
  /** Classify the spec, record the decision, and enqueue an ambiguous spec for review. */
  moderate(
    spec: ModerationSpec & { resourceId: string },
    store: ModerationStore,
  ): Promise<ClassificationResult>;
}

/** The deterministic keyword/rule moderator (autonomous test default). */
export class KeywordModerator implements Moderator {
  readonly backend = "keyword" as const;

  async moderate(
    spec: ModerationSpec & { resourceId: string },
    store: ModerationStore,
  ): Promise<ClassificationResult> {
    const result = classify(spec);
    await store.recordDecision({
      resourceId: spec.resourceId,
      decision: result.decision,
      reason: result.reason,
      timestamp: Date.now(),
    });
    if (result.decision === "review") {
      await store.enqueueReview({
        resourceId: spec.resourceId,
        prompt: spec.prompt,
        reason: result.reason,
        timestamp: Date.now(),
      });
    }
    return result;
  }
}

/**
 * The model-backed moderator (operator-gated). It is constructed only when
 * ANTHROPIC_API_KEY is present; the live model call path is not exercised
 * autonomously. Until the operator wires the live classifier it falls back to the
 * deterministic rules so a misconfig fails safe (block/review still apply).
 */
export class ModelModerator implements Moderator {
  readonly backend = "model" as const;
  private readonly keyword = new KeywordModerator();
  private readonly config: { apiKey: string; model?: string };

  constructor(config: { apiKey: string; model?: string }) {
    this.config = config;
  }

  async moderate(
    spec: ModerationSpec & { resourceId: string },
    store: ModerationStore,
  ): Promise<ClassificationResult> {
    // Operator-gated: the live model enrichment is a Deferred Item. Until then the
    // deterministic floor still records + enqueues (fail-safe, never an open allow).
    return this.keyword.moderate(spec, store);
  }
}

/**
 * Env-driven moderator selection, mirroring selectGenerator. Defaults to the keyword
 * backend whenever MODERATION_BACKEND is `keyword` OR ANTHROPIC_API_KEY is absent -
 * so the autonomous suite never reaches a model/network path. Otherwise selects the
 * model backend (operator-gated).
 */
export function selectModerator(env: NodeJS.ProcessEnv = process.env): Moderator {
  if (env.MODERATION_BACKEND === "keyword" || !env.ANTHROPIC_API_KEY) {
    return new KeywordModerator();
  }
  return new ModelModerator({ apiKey: env.ANTHROPIC_API_KEY, model: env.MODERATION_MODEL });
}
