// prepublish.test.ts - the static pre-publish scans FLAG the malicious DoD
// fixture and PASS the benign control (SBX-06). Source-only: the fixtures are
// read as text and analyzed; they are NEVER imported or executed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanImports } from "../src/prepublish/import-scan";
import { scanSecrets } from "../src/prepublish/secret-scan";
import { runPrePublishStaticChecks } from "../src/prepublish/checks";
import {
  RequiresProvisionedHostError,
  createOperatorGatedProbe,
} from "../src/prepublish/probe";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

const maliciousSource = read("fixtures/malicious/handler.ts");
const benignSource = read("fixtures/benign/handler.ts");

describe("prepublish - import scan (SBX-06b)", () => {
  it("flags the `net` import in the malicious fixture", () => {
    const v = scanImports(maliciousSource);
    expect(v.some((x) => x.rule === "disallowed-import" && x.message.includes("net"))).toBe(true);
  });

  it("flags process.env enumeration in the malicious fixture", () => {
    const v = scanImports(maliciousSource);
    expect(v.some((x) => x.rule === "process-env-enumeration")).toBe(true);
  });

  it("flags every deny-listed module (child_process/net/dgram/cluster/worker_threads)", () => {
    const src = [
      'import cp from "child_process";',
      'import net from "net";',
      'import dgram from "node:dgram";',
      'const c = require("cluster");',
      'const w = await import("worker_threads");',
    ].join("\n");
    const v = scanImports(src);
    const flagged = v.filter((x) => x.rule === "disallowed-import");
    expect(flagged.length).toBe(5);
  });

  it("flags /proc and /sys host-path reads", () => {
    const v = scanImports('import fs from "fs"; const x = fs.readFileSync("/proc/self/environ");');
    expect(v.some((x) => x.rule === "fs-proc-sys-read")).toBe(true);
  });

  it("returns NO violations for the benign control", () => {
    expect(scanImports(benignSource)).toEqual([]);
  });
});

describe("prepublish - secret scan (SBX-06a)", () => {
  it("flags an embedded secret (regex + entropy)", () => {
    const bundle = {
      "handler.ts":
        benignSource +
        '\nconst AWS = "AKIAIOSFODNN7EXAMPLE";' +
        '\nconst key = "0x' +
        "a3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60a3f9c2e1b7d48f60" +
        '";',
    };
    const v = scanSecrets(bundle);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.rule === "aws-access-key-id" || x.rule === "hex-private-key")).toBe(true);
  });

  it("flags a high-entropy generic token the named rules miss", () => {
    const bundle = { "cfg.ts": 'const t = "Zk9Qm2Xy7Lp4Rt6Vb8Nc1Wd3Fg5Hj0";' };
    const v = scanSecrets(bundle);
    expect(v.some((x) => x.rule === "high-entropy-string")).toBe(true);
  });

  it("flags an OpenAI-style sk- provider key by a named rule (IN-03)", () => {
    const bundle = {
      "cfg.ts": 'const key = "sk-abcdefABCDEF0123456789ghijklmn";',
    };
    const v = scanSecrets(bundle);
    expect(v.some((x) => x.rule === "openai-style-key")).toBe(true);
  });

  it("passes a clean benign bundle", () => {
    expect(scanSecrets({ "handler.ts": benignSource })).toEqual([]);
  });
});

describe("prepublish - combined static gate", () => {
  it("FAILS the malicious fixture (with an injected secret) and lists violations", () => {
    const bundle = {
      "handler.ts": maliciousSource + '\nconst leak = "AKIAIOSFODNN7EXAMPLE";',
    };
    const result = runPrePublishStaticChecks(bundle);
    expect(result.pass).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    // It catches the import + env vectors AND the embedded secret.
    expect(result.violations.some((v) => v.kind === "import")).toBe(true);
    expect(result.violations.some((v) => v.kind === "secret")).toBe(true);
  });

  it("PASSES the benign control", () => {
    const result = runPrePublishStaticChecks({ "handler.ts": benignSource });
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("prepublish - dynamic probe is operator-gated", () => {
  it("the stub is not available autonomously", () => {
    expect(createOperatorGatedProbe().available).toBe(false);
  });

  it("assertBlocked throws RequiresProvisionedHostError when invoked autonomously", async () => {
    const probe = createOperatorGatedProbe();
    await expect(probe.assertBlocked({} as never, [])).rejects.toBeInstanceOf(
      RequiresProvisionedHostError,
    );
  });
});
