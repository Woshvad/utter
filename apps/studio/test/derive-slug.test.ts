// derive-slug.test.ts - the deriveSlug defense-in-depth reserved-name guard (H2).
//
// deriveSlug turns a creator prompt into a discovery slug. A prompt like
// "marketplace price feed" would otherwise derive the bare slug "marketplace",
// which collides with the operator marketplace router file basename and would
// overwrite that control-plane router on deploy. The deployer's validateSlug is the
// authoritative reject; deriveSlug is defense-in-depth so the studio never even
// derives a name the deployer would reject. These tests assert a derived slug is
// never empty and never a bare reserved operator name, and that the transform is
// deterministic.
import { describe, it, expect } from "vitest";
import { deriveSlug } from "../app/adapter/live";

const RESERVED = ["studio", "marketplace", "traefik", "api", "app", "dashboard", "ping", "health"];

describe("deriveSlug - reserved-name defense-in-depth (H2)", () => {
  it("does not return a bare reserved slug for a prompt that would derive one", () => {
    const slug = deriveSlug("marketplace price feed");
    // The leading word "marketplace" must not survive as the whole slug. Here the
    // prompt has more words so it derives "marketplace-price-feed" (not reserved),
    // but the guard is what makes a single-word reserved prompt safe (next case).
    expect(RESERVED).not.toContain(slug);
    expect(slug).toBe("marketplace-price-feed");
  });

  it.each(RESERVED)("transforms a bare reserved prompt %s deterministically", (word) => {
    const slug = deriveSlug(word);
    expect(RESERVED).not.toContain(slug);
    expect(slug).toBe(`api-${word}`);
    // Deterministic: the same prompt yields the same slug (no randomness).
    expect(deriveSlug(word)).toBe(slug);
  });

  it("a reserved prompt with surrounding punctuation still gets transformed", () => {
    // "  Marketplace!  " normalizes to "marketplace", which is reserved -> prefixed.
    expect(deriveSlug("  Marketplace!  ")).toBe("api-marketplace");
  });

  it("falls back to a stable local slug for an empty-deriving prompt", () => {
    expect(deriveSlug("!!!")).toBe("local-resource");
    expect(deriveSlug("")).toBe("local-resource");
  });

  it("leaves a normal prompt slug unchanged", () => {
    expect(deriveSlug("Weather Bot for cities")).toBe("weather-bot-for-cities");
  });

  it("every derived slug matches the deployer charset and is never reserved", () => {
    const prompts = ["marketplace", "studio", "api", "Weather Bot", "!!!", "Health check probe"];
    for (const p of prompts) {
      const slug = deriveSlug(p);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(RESERVED).not.toContain(slug);
    }
  });
});
