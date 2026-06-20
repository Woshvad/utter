// claude-backend.test.ts - the OPERATOR-GATED claude backend is type-checkable,
// selectable, and constructed without any network call. This suite NEVER invokes
// ClaudeGenerator.generate (that path needs ANTHROPIC_API_KEY + network and is
// validated by the same four 04-03 gates, never run autonomously). The only runtime
// assertions are: the discriminator, network-free construction, and that the public
// generate() barrel routes through selectGenerator to the scaffold backend with no
// key. The agent-loop constraints are asserted statically by reading the source.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { ClaudeGenerator } from "../src/claude-backend.js";
import { generate } from "../src/index.js";
import { BUNDLE_KEYS } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

describe("ClaudeGenerator (operator-gated - constructed, never invoked)", () => {
  it("has the claude discriminator", () => {
    const gen = new ClaudeGenerator({ apiKey: "sk-ant-test", model: "claude-sonnet-4-6" });
    expect(gen.backend).toBe("claude");
  });

  it("constructs without any network call (config stored only)", () => {
    // A throw or hang here would mean construction contacted the network. The
    // constructor must only store config - the model is reached solely in generate().
    expect(
      () => new ClaudeGenerator({ apiKey: "sk-ant-test", model: "claude-opus-4-8" }),
    ).not.toThrow();
  });
});

describe("claude-backend.ts source discipline (static assertions, no runtime call)", () => {
  const src = readFileSync(join(SRC, "claude-backend.ts"), "utf8");

  it("imports the Agent SDK query() loop", () => {
    expect(src).toContain('from "@anthropic-ai/claude-agent-sdk"');
    expect(src).toContain("query(");
  });

  it("carries the loud operator-gated header", () => {
    expect(src).toContain("OPERATOR-GATED");
    expect(src.toLowerCase()).toContain("never the ci");
  });

  it("constrains the toolset: Write/Read only, Bash/WebFetch/WebSearch disallowed, settingSources []", () => {
    expect(src).toContain('allowedTools: ["Write", "Read"]');
    expect(src).toContain('disallowedTools: ["Bash", "WebFetch", "WebSearch"]');
    expect(src).toContain("settingSources: []");
  });

  it("overwrites the Dockerfile via the platform generateDockerfile (never model free-form)", () => {
    expect(src).toContain("generateDockerfile");
    expect(src).toContain('bundle["Dockerfile"]');
  });

  it("passes the configured apiKey + model through to the query() call (WR-02)", () => {
    // The executor must honor the selector's key/model, not silently depend on the
    // ambient process env. The model flows via options.model and the key via the
    // SDK env override (which replaces the subprocess env).
    expect(src).toContain("model: this.config.model");
    expect(src).toContain("ANTHROPIC_API_KEY: this.config.apiKey");
  });

  it("bounds the untrusted model temp tree read (WR-03)", () => {
    // readBundleFromDir must cap file count + size and reject non-BUNDLE_KEYS files.
    expect(src).toContain("MAX_BUNDLE_FILES");
    expect(src).toContain("MAX_BUNDLE_FILE_BYTES");
    expect(src).toContain("BUNDLE_KEY_SET.has");
  });

  it("cleans up the temp dir in a finally (IN-05)", () => {
    expect(src).toContain("finally");
    expect(src).toContain("rmSync(tmpDir");
  });
});

describe("generate() barrel (autonomous: scaffold-only, no key)", () => {
  it("routes through selectGenerator to the scaffold backend with no ANTHROPIC_API_KEY", async () => {
    const bundle = await generate(
      {
        prompt: "Echo the input text back with its length.",
        runtime: "node",
        pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
      },
      {}, // empty env -> scaffold backend, zero model calls
    );
    expect(Object.keys(bundle).sort()).toEqual([...BUNDLE_KEYS].sort());
  });
});
