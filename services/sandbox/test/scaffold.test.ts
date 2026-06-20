// Phase 3 Wave 0 scaffold smoke test (SBX-06 DoD fixture shape + workspace
// hygiene). These assertions read SOURCE TEXT only — the malicious fixture is
// NEVER imported or executed here (RESEARCH Pattern 6: the static scans read the
// source string; live execution is the operator-gated gVisor probe in Plan 06).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8");

describe("Phase 3 scaffold (Wave 0)", () => {
  const malicious = read("services/sandbox/test/fixtures/malicious/handler.ts");
  const benign = read("services/sandbox/test/fixtures/benign/handler.ts");

  it("malicious fixture exercises all three SBX-06 attack vectors", () => {
    // 1. cloud-metadata SSRF target
    expect(malicious).toContain("169.254.169.254");
    // 2. dangerous-import: raw socket via `net`
    expect(malicious).toMatch(/import\s+net\s+from\s+["']net["']/);
    expect(malicious).toContain("net.connect");
    // 3. platform env enumeration
    expect(malicious).toContain("process.env");
  });

  it("benign fixture is a clean negative control (none of the attack vectors)", () => {
    expect(benign).not.toContain("169.254.169.254");
    expect(benign).not.toMatch(/from\s+["']net["']/);
    expect(benign).not.toContain("net.connect");
    expect(benign).not.toContain("process.env");
  });

  it(".env.example carries the Phase 3 placeholders", () => {
    const env = read(".env.example");
    expect(env).toContain("DATA_PROXY_TOKEN_SECRET");
    expect(env).toContain("REGISTRY_MIRROR_URL");
    expect(env).toContain("DNS_PROVIDER");
    expect(env).toContain("SANDBOX_RUNTIME");
  });

  it("no `traefik` npm dependency exists in any new member package.json", () => {
    for (const member of [
      "services/sandbox/package.json",
      "services/deployer/package.json",
      "packages/data-proxy/package.json",
    ]) {
      const pkg = JSON.parse(read(member)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.traefik).toBeUndefined();
      expect(pkg.devDependencies?.traefik).toBeUndefined();
    }
  });

  it("the three new members resolve and import the Phase 2 workspace deps", () => {
    const sandbox = JSON.parse(read("services/sandbox/package.json")) as {
      name: string;
      type: string;
      dependencies: Record<string, string>;
    };
    expect(sandbox.name).toBe("@utter/sandbox");
    expect(sandbox.type).toBe("module");
    expect(sandbox.dependencies["@utter/x402-arc"]).toBe("workspace:*");
    expect(sandbox.dependencies["@utter/chain"]).toBe("workspace:*");

    const deployer = JSON.parse(read("services/deployer/package.json")) as { name: string };
    expect(deployer.name).toBe("@utter/deployer");

    const proxy = JSON.parse(read("packages/data-proxy/package.json")) as { name: string };
    expect(proxy.name).toBe("@utter/data-proxy");
  });

  it("infrastructure references the traefik:v3 Docker image (not an npm package)", () => {
    const compose = read("infrastructure/docker-compose.yml");
    expect(compose).toContain("traefik:v3");
  });
});
