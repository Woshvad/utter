// live-deps-card-url.test.ts - the offline test for the DEPLOY_DOMAIN cardUrl resolver
// and the canonical seeded echo entry (260625-4q5, RESOURCE-DEPLOY-DESIGN.md §5.4 + §5.5).
//
// resolveCardUrl is the ONE place that reads DEPLOY_DOMAIN; live.ts stays env-free and
// receives the bound buildCardUrl. The seeded echo entry's resourceId must equal the
// shared resourceIdForLabel(ECHO_RESOURCE_LABEL) so the studio targets the SAME id the
// deployer registers and the resource advertises. No network, no chain call.
import { describe, it, expect } from "vitest";
import { resourceIdForLabel, ECHO_RESOURCE_LABEL } from "@utter/x402-arc";
import { resolveCardUrl, buildLiveDeps, memoizeList } from "../app/adapter/live-deps.server";
import type { IndexRecord } from "@utter/marketplace";

describe("resolveCardUrl (DEPLOY_DOMAIN agent-card URL)", () => {
  it("builds https://<slug>.resources.<domain>/.well-known/agent-card.json from DEPLOY_DOMAIN", () => {
    const url = resolveCardUrl("echo", { DEPLOY_DOMAIN: "utter.technology" } as NodeJS.ProcessEnv);
    expect(url).toBe("https://echo.resources.utter.technology/.well-known/agent-card.json");
  });

  it("falls back to the example.com local-dev literal when DEPLOY_DOMAIN is unset", () => {
    const url = resolveCardUrl("echo", {} as NodeJS.ProcessEnv);
    expect(url).toBe("https://echo.resources.example.com/.well-known/agent-card.json");
  });

  it("guards a double resources. prefix when the domain already starts with resources.", () => {
    // .env.example carries resources.example.com; the apex must not become
    // resources.resources.example.com.
    const url = resolveCardUrl("echo", {
      DEPLOY_DOMAIN: "resources.example.com",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://echo.resources.example.com/.well-known/agent-card.json");
    expect(url).not.toContain("resources.resources.");
  });

  it("tolerates a stray scheme/trailing dot/slash on the configured domain", () => {
    const url = resolveCardUrl("echo", {
      DEPLOY_DOMAIN: "https://utter.technology./",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://echo.resources.utter.technology/.well-known/agent-card.json");
  });
});

describe("seeded echo entry (canonical cross-piece id, §5.5)", () => {
  it("seeds an echo record whose resourceId == resourceIdForLabel(ECHO_RESOURCE_LABEL) with a payTo-shaped id", async () => {
    // buildLiveDeps constructs an Arc public client (no network call at construction) and
    // returns the module-singleton seeded store. The echo entry is the cross-piece id.
    const deps = buildLiveDeps({ DEPLOY_DOMAIN: "utter.technology" } as NodeJS.ProcessEnv);
    const echoId = resourceIdForLabel(ECHO_RESOURCE_LABEL);
    // The pinned rework-1 id; assert the seed agrees with the deployer-registered id.
    expect(echoId).toBe(
      "0x17cc4ce3443152e31fda90928d99aa0d0e307f044f642538b6173cbd62998446",
    );
    const record = await deps.indexStore.get(echoId);
    expect(record).toBeDefined();
    expect(record?.resourceId).toBe(echoId);
    // The seeded card origin is built from DEPLOY_DOMAIN via the injected builder. The
    // store is a module singleton seeded on first build, so the domain is whatever the
    // first buildLiveDeps in this process used; assert the shape, not a fixed domain.
    expect(record?.cardUrl).toMatch(
      /^https:\/\/echo\.resources\.[a-z0-9.-]+\/\.well-known\/agent-card\.json$/,
    );
  });
});

describe("buildLiveDeps publishToMarketplace seam (env-conditional binding)", () => {
  it("binds publishToMarketplace only when BOTH MARKETPLACE_URL and MARKETPLACE_AUTH_SECRET are set", () => {
    const deps = buildLiveDeps({
      MARKETPLACE_URL: "https://marketplace.example.com",
      MARKETPLACE_AUTH_SECRET: "test-marketplace-secret-at-least-32-chars-long",
    } as NodeJS.ProcessEnv);
    expect(typeof deps.publishToMarketplace).toBe("function");
  });

  it("leaves publishToMarketplace undefined when MARKETPLACE_AUTH_SECRET is missing", () => {
    const deps = buildLiveDeps({
      MARKETPLACE_URL: "https://marketplace.example.com",
    } as NodeJS.ProcessEnv);
    expect(deps.publishToMarketplace).toBeUndefined();
  });

  it("leaves publishToMarketplace undefined when MARKETPLACE_URL is missing", () => {
    const deps = buildLiveDeps({
      MARKETPLACE_AUTH_SECRET: "test-marketplace-secret-at-least-32-chars-long",
    } as NodeJS.ProcessEnv);
    expect(deps.publishToMarketplace).toBeUndefined();
  });

  it("leaves publishToMarketplace undefined when both are blank/whitespace", () => {
    const deps = buildLiveDeps({
      MARKETPLACE_URL: "   ",
      MARKETPLACE_AUTH_SECRET: "   ",
    } as NodeJS.ProcessEnv);
    expect(deps.publishToMarketplace).toBeUndefined();
  });
});

describe("memoizeList (discovery-read coalescing memo, kills the dashboard N+1)", () => {
  it("coalesces a CONCURRENT burst into ONE underlying fetch", async () => {
    let calls = 0;
    const memo = memoizeList(async () => {
      calls += 1;
      return [] as IndexRecord[];
    }, 3000);
    // Mirror the dashboard's Promise.all(getResourceDetail-per-card) fan-out: N concurrent reads.
    await Promise.all([memo(), memo(), memo(), memo(), memo()]);
    expect(calls).toBe(1);
  });

  it("serves a second call within the TTL from cache (no re-fetch)", async () => {
    let calls = 0;
    const memo = memoizeList(async () => {
      calls += 1;
      return [] as IndexRecord[];
    }, 3000);
    await memo();
    await memo();
    expect(calls).toBe(1);
  });

  it("does NOT cache a rejected fetch: the next call retries the read", async () => {
    let calls = 0;
    const memo = memoizeList(async () => {
      calls += 1;
      throw new Error("marketplace unreachable");
    }, 3000);
    await expect(memo()).rejects.toThrow();
    await expect(memo()).rejects.toThrow();
    // A failed fetch is dropped from the cache so the second call really retries (calls=2).
    expect(calls).toBe(2);
  });
});
