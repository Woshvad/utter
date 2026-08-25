// static-gate.test.ts (GEN-02) - the four-gate validator's G2 rejects a malicious
// generated bundle BEFORE any deploy hand-off. G2 reuses runPrePublishStaticChecks
// from @utter/sandbox VERBATIM (no re-implemented scanner here): a literal upstream
// key, a disallowed (net/child_process) import, or process.env enumeration in the
// generated handler.ts FAILS the bundle. The clean scaffold bundle is the negative
// control (G2 passes). The rule names (secret rules, "disallowed-import",
// "process-env-enumeration") come from secret-scan.ts / import-scan.ts.
import { describe, it, expect } from "vitest";
import { ScaffoldGenerator } from "../src/scaffold.js";
import { validateBundle } from "../src/validate.js";
import type { Bundle, ResourceSpec } from "../src/types.js";

const spec: ResourceSpec = {
  prompt: "Echo the input text back with its length.",
  runtime: "node",
  pricing: { model: "metered", base: "5000", perKB: "100", max: "10000" },
};

async function scaffold(): Promise<Bundle> {
  return new ScaffoldGenerator().generate(spec);
}

/** Splice a fragment into the generated handler.ts (after its import line). */
function mutateHandler(bundle: Bundle, inject: string): Bundle {
  const handler = bundle["handler.ts"]!;
  return { ...bundle, "handler.ts": `${handler}\n${inject}\n` };
}

/** Smuggle a value into a parsed-JSON artifact at the given dotted path. */
function smuggleIntoJson(bundle: Bundle, key: string, set: (doc: any) => void): Bundle {
  const doc = JSON.parse(bundle[key]!);
  set(doc);
  return { ...bundle, [key]: JSON.stringify(doc, null, 2) };
}

describe("static-gate (GEN-02): a malicious generated bundle is blocked at G2", () => {
  it("rejects a handler that embeds a literal sk- provider key (secret rule)", async () => {
    const malicious = mutateHandler(
      await scaffold(),
      'const UPSTREAM_KEY = "sk-abcdefABCDEF0123456789ghijklmn";',
    );
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(result.gates.g2.pass).toBe(false);
    const g2 = result.gates.g2.violations;
    expect(g2.some((v) => v.kind === "secret" && v.file === "handler.ts")).toBe(true);
    expect(g2.some((v) => v.rule === "openai-style-key")).toBe(true);
  });

  it("rejects a handler that embeds a literal 0x<64hex> private key (secret rule)", async () => {
    const malicious = mutateHandler(
      await scaffold(),
      'const PRIV = "0xa3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60";',
    );
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(result.gates.g2.pass).toBe(false);
    expect(
      result.gates.g2.violations.some(
        (v) => v.kind === "secret" && v.rule === "hex-private-key",
      ),
    ).toBe(true);
  });

  it("rejects a handler that imports net (disallowed-import)", async () => {
    const malicious = mutateHandler(await scaffold(), 'import net from "net";');
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(result.gates.g2.pass).toBe(false);
    expect(
      result.gates.g2.violations.some(
        (v) => v.kind === "import" && v.rule === "disallowed-import" && v.file === "handler.ts",
      ),
    ).toBe(true);
  });

  it("rejects a handler that imports child_process (disallowed-import)", async () => {
    const malicious = mutateHandler(
      await scaffold(),
      'import { exec } from "child_process";',
    );
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(
      result.gates.g2.violations.some(
        (v) => v.kind === "import" && v.rule === "disallowed-import",
      ),
    ).toBe(true);
  });

  it("rejects a handler that enumerates process.env (process-env-enumeration)", async () => {
    const malicious = mutateHandler(
      await scaffold(),
      "const leaked = Object.keys(process.env);",
    );
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(result.gates.g2.pass).toBe(false);
    expect(
      result.gates.g2.violations.some(
        (v) => v.kind === "import" && v.rule === "process-env-enumeration",
      ),
    ).toBe(true);
  });

  it("passes G2 for the clean scaffold bundle (negative control)", async () => {
    const result = await validateBundle(await scaffold(), spec);
    // The whole validator passes, and in particular G2 is green with no violations.
    expect(result.gates.g2.pass).toBe(true);
    expect(result.gates.g2.violations).toHaveLength(0);
  });
});

describe("static-gate (GEN-02 / WR-01): a secret smuggled into a JSON artifact is blocked at G2", () => {
  it("rejects an sk- provider key hidden in an openapi.json description", async () => {
    const malicious = smuggleIntoJson(await scaffold(), "openapi.json", (doc) => {
      doc.info.description = "Calls upstream with key sk-abcdefABCDEF0123456789ghijklmn";
    });
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(result.gates.g2.pass).toBe(false);
    expect(
      result.gates.g2.violations.some(
        (v) => v.kind === "secret" && v.file === "openapi.json" && v.rule === "openai-style-key",
      ),
    ).toBe(true);
  });

  it("rejects a 0x<64hex> private key hidden in a key-context field of test-cases.json", async () => {
    // A realistic smuggle: the hex is bound to a private-key-named field, so the
    // hex-private-key rule fires. A BARE 0x<64hex> (no key context) is deliberately NOT
    // flagged here - it is byte-identical to a public payTo / resourceId that legitimate
    // bundles carry, so flagging it would false-positive on every real deploy (see the
    // negative control below).
    const malicious = smuggleIntoJson(await scaffold(), "test-cases.json", (doc) => {
      doc.cases[0].input.privateKey =
        "0xa3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60";
    });
    const result = await validateBundle(malicious, spec);
    expect(result.pass).toBe(false);
    expect(result.gates.g2.pass).toBe(false);
    expect(
      result.gates.g2.violations.some(
        (v) => v.kind === "secret" && v.file === "test-cases.json" && v.rule === "hex-private-key",
      ),
    ).toBe(true);
  });

  it("does NOT false-positive on a BARE 0x<64hex> (a public resourceId/payTo shape) in test-cases.json", async () => {
    // A bare 0x<64hex> with no key context is a PUBLIC value shape (resourceId, payTo, tx
    // hash). The gate must let it through, or every on-chain bundle that references a
    // resourceId in a test case would be blocked. This pins the deliberate boundary.
    const benign = smuggleIntoJson(await scaffold(), "test-cases.json", (doc) => {
      doc.cases[0].input.resourceId =
        "0xa3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60";
    });
    const result = await validateBundle(benign, spec);
    expect(
      result.gates.g2.violations.some((v) => v.file === "test-cases.json"),
    ).toBe(false);
  });

  it("does NOT false-positive on the public PaymentEscrow/USDC addresses in agent-card.json", async () => {
    // The clean scaffold agent-card.json carries the 42-char public escrow/USDC
    // addresses. The named-rule pass (entropy waived for JSON) must let them pass.
    const result = await validateBundle(await scaffold(), spec);
    expect(result.gates.g2.pass).toBe(true);
    expect(
      result.gates.g2.violations.some((v) => v.file === "agent-card.json"),
    ).toBe(false);
  });
});
