// scaffold.ts - the deterministic, zero-model-call generator backend (GEN-03).
//
// This is the test default and the guaranteed-valid bundle floor: given a
// ResourceSpec it returns a complete five-file Bundle (exactly BUNDLE_KEYS),
// templated from the proven echo bundle (packages/x402-arc/examples/echo/*). It
// makes NO model call and reaches NO network - constructing and running it never
// touches ANTHROPIC_API_KEY. The same four 04-03 gates that validate the model
// backend's output validate this bundle; this is the floor they always pass.
//
// Two invariants are load-bearing:
//   1. The Dockerfile is ALWAYS produced by the platform generateDockerfile
//      (digest-pinned base, SBX-05). An untrusted free-form FROM line never enters
//      the bundle - the scaffold overwrites the Dockerfile key with the platform
//      output.
//   2. The generated handler reaches upstreams ONLY via EGRESS_PROXY_URL with the
//      runtime-injected scoped token (x-resource-token). It NEVER embeds a raw key,
//      so the 04-03 G2 secret scan stays green (GEN-02 / PRX-01).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateDockerfile, PINNED_BASE_IMAGES } from "@utter/deployer";
import type { Generator } from "./generator.js";
import { BUNDLE_KEYS, type Bundle, type ResourceSpec } from "./types.js";
import { buildAgentCard } from "./agent-card.js";

// The module dir, resolved as an absolute path (ESM + Windows safe, RESEARCH
// Pitfall 1/3). The handler template lives under skills/templates relative to src/.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const HANDLER_TEMPLATE_PATH = join(MODULE_DIR, "..", "skills", "templates", "handler.ts.tmpl");

// The keyless-egress block substituted into the handler template when the spec
// declares upstreams. It routes through EGRESS_PROXY_URL with the scoped token in
// x-resource-token / x-resource-id / x-upstream-url (names from
// packages/data-proxy/src/proxy.ts). It NEVER embeds a literal key - the data-proxy
// injects the real credential server-side, so the secret scan stays green.
const UPSTREAM_BLOCK = `
  // Keyless egress: reach the upstream ONLY through the data-proxy. The real key is
  // injected server-side by the proxy; this handler holds the scoped token only.
  const proxyBase = process.env.EGRESS_PROXY_URL;
  if (proxyBase) {
    const upstream = await fetch(proxyBase + "/proxy", {
      method: "POST",
      headers: {
        "x-resource-token": process.env.RESOURCE_TOKEN ?? "",
        "x-resource-id": process.env.RESOURCE_ID ?? "",
        "x-upstream-url": process.env.UPSTREAM_URL ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!upstream.ok) {
      return c.json({ error: "upstream request failed", code: "UPSTREAM_ERROR" }, 400);
    }
  }
`;

/** Read the handler template and substitute the upstream block (or remove it). */
function buildHandler(spec: ResourceSpec): string {
  const template = readFileSync(HANDLER_TEMPLATE_PATH, "utf8");
  const hasUpstreams = Array.isArray(spec.upstreams) && spec.upstreams.length > 0;
  return template.replace("__UPSTREAM_BLOCK__", hasUpstreams ? UPSTREAM_BLOCK : "");
}

/**
 * Derive resource-named openapi component schema names from the runtime. The
 * parameterized buildClassifier (@utter/x402-arc) consumes these via
 * { successRef, errorRef }. They are stable per-bundle and PascalCase so they read
 * as schema names (e.g. ResourceSuccess / ResourceError).
 */
const SUCCESS_SCHEMA = "ResourceSuccess";
const ERROR_SCHEMA = "ResourceError";

/** Build the openapi.json: openapi 3.1, success + documented-error component schemas. */
function buildOpenapi(spec: ResourceSpec): string {
  const title = spec.prompt.slice(0, 80).trim() || "Resource";
  const doc = {
    $id: "openapi.json",
    openapi: "3.1.0",
    info: {
      title,
      version: "1.0.0",
      description: spec.prompt,
    },
    paths: {
      "/": {
        post: {
          summary: title,
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${SUCCESS_SCHEMA}` },
                },
              },
            },
            "400": {
              description: "Declared error (bad buyer input)",
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${ERROR_SCHEMA}` },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        [SUCCESS_SCHEMA]: {
          type: "object",
          additionalProperties: false,
          required: ["result", "length"],
          properties: {
            result: { type: "string" },
            length: { type: "integer", minimum: 0 },
          },
        },
        [ERROR_SCHEMA]: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
        },
      },
    },
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Build test-cases.json with at least one case each of success / declared_error /
 * malfunction so the 04-03 validator proves all three classifier branches against
 * the openapi above (CONTEXT decision).
 */
function buildTestCases(spec: ResourceSpec): string {
  const doc = {
    description: `Fixtures the response gate classifies (success | declared_error | malfunction) for: ${spec.prompt}`,
    cases: [
      {
        label: "success",
        input: { text: "hello" },
        response: { result: "hello", length: 5 },
        expectedClass: "success",
      },
      {
        label: "declared_error",
        input: { text: 123 },
        response: { error: "text must be a string", code: "BAD_INPUT" },
        expectedClass: "declared_error",
      },
      {
        label: "malfunction",
        input: { text: "hello" },
        response: { unexpected: "field", length: "not-an-integer" },
        expectedClass: "malfunction",
      },
    ],
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * The deterministic scaffold backend. Returns the complete five-file Bundle keyed
 * by the BUNDLE_KEYS literals with zero model calls. The Dockerfile is OVERWRITTEN
 * by the platform generateDockerfile (digest-pinned), never free-form.
 */
export class ScaffoldGenerator implements Generator {
  readonly backend = "scaffold" as const;

  async generate(spec: ResourceSpec): Promise<Bundle> {
    // Build each file keyed by the literal POSIX BUNDLE_KEYS (never path.join, so a
    // Windows backslash can never enter a key - RESEARCH Pitfall 3).
    const bundle: Bundle = {
      "handler.ts": buildHandler(spec),
      "openapi.json": buildOpenapi(spec),
      "agent-card.json": JSON.stringify(buildAgentCard(spec), null, 2),
      "test-cases.json": buildTestCases(spec),
      // Dockerfile is ALWAYS platform-produced (digest-pinned base) - never a
      // free-form FROM line. This keeps the SBX-05 by-digest pin intact.
      Dockerfile: generateDockerfile({
        runtime: spec.runtime,
        baseImage: PINNED_BASE_IMAGES[spec.runtime],
        registryUrl: process.env.REGISTRY_MIRROR_URL ?? "",
      }),
    };

    // Defensive: the bundle key set must be EXACTLY BUNDLE_KEYS.
    const keys = Object.keys(bundle).sort();
    const expected = [...BUNDLE_KEYS].sort();
    if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
      throw new Error(`scaffold: bundle keys ${keys.join(",")} != BUNDLE_KEYS ${expected.join(",")}`);
    }
    return bundle;
  }
}
