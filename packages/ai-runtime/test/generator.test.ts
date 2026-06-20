// selectGenerator branch + BUNDLE_KEYS contract suite (GEN-01/03). Offline unit
// test - no key, no network. Proves the deterministic-default invariant: the
// suite reaches `scaffold` whenever ANTHROPIC_API_KEY is absent or scaffold is
// forced, and only constructs the claude backend (lazily, no network) when a key
// is present and scaffold is not forced.
import { describe, it, expect } from "vitest";
import { selectGenerator, BUNDLE_KEYS } from "../src/index.js";

describe("selectGenerator (GEN-01/03)", () => {
  it("returns the scaffold backend when ANTHROPIC_API_KEY is absent", () => {
    const gen = selectGenerator({});
    expect(gen.backend).toBe("scaffold");
  });

  it("returns the scaffold backend when AI_RUNTIME_GENERATOR=scaffold even if a key is set", () => {
    const gen = selectGenerator({
      ANTHROPIC_API_KEY: "sk-ant-present",
      AI_RUNTIME_GENERATOR: "scaffold",
    });
    expect(gen.backend).toBe("scaffold");
  });

  it("returns the claude backend when a key is set and scaffold is not forced", () => {
    const gen = selectGenerator({ ANTHROPIC_API_KEY: "sk-ant-present" });
    expect(gen.backend).toBe("claude");
  });

  it("constructs the claude backend without any network call (selection from env alone)", () => {
    // selectGenerator must not await/contact anything; constructing the claude
    // backend only stores config. A throw here would surface a network attempt.
    expect(() =>
      selectGenerator({ ANTHROPIC_API_KEY: "sk-ant-present", DEFAULT_MODEL: "claude-opus-4-8" }),
    ).not.toThrow();
  });

  it("defaults the env arg to process.env without a model/network path", () => {
    // With no ANTHROPIC_API_KEY in the test process env, the default-arg path
    // must select scaffold (the load-bearing autonomous-suite invariant).
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(selectGenerator().backend).toBe("scaffold");
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

describe("BUNDLE_KEYS contract (GEN-01)", () => {
  it("is exactly the five POSIX literals in order", () => {
    expect(BUNDLE_KEYS).toEqual([
      "handler.ts",
      "Dockerfile",
      "openapi.json",
      "agent-card.json",
      "test-cases.json",
    ]);
  });

  it("carries no backslash path separators (Windows pitfall guard)", () => {
    for (const key of BUNDLE_KEYS) {
      expect(key).not.toContain("\\");
    }
  });
});
