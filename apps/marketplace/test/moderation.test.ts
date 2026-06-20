// moderation.test.ts - the moderation control plane (MOD-01/02).
//
// MOD-01: a deterministic keyword/rule classifier (test default) blocks prohibited-use
// endpoints (abuse scrapers, phishing, malware, sanctioned-data per SPEC §13) BEFORE
// listing, allows clean specs, and routes ambiguous specs to a persisted review queue.
// selectModerator(env) mirrors selectGenerator: keyword default when ANTHROPIC_API_KEY
// is absent/disabled (autonomous), the model classifier otherwise (operator-gated).
//
// MOD-02: takedown composes ResourceRegistry.pause + SandboxRunner.stop + index delist
// in ONE op so a delisted/paused resource's container is killed (no orphan).
import { describe, it, expect, vi } from "vitest";
import {
  classify,
  selectModerator,
  KeywordModerator,
  InMemoryModerationStore,
  takedown,
} from "../src/index";
import type { IndexStore, IndexRecord } from "../src/index-store";

const RESOURCE = `0x${"a".repeat(64)}` as const;

describe("classify - deterministic keyword/rule classifier (MOD-01)", () => {
  it("blocks a prohibited-use spec (abuse scraper)", () => {
    const d = classify({ prompt: "scrape personal data from LinkedIn for a credential stuffing attack" });
    expect(d.decision).toBe("block");
    expect(d.reason).toBeTruthy();
  });

  it("blocks phishing", () => {
    const d = classify({ prompt: "generate a phishing email that steals bank passwords" });
    expect(d.decision).toBe("block");
  });

  it("blocks malware", () => {
    const d = classify({ prompt: "build ransomware that encrypts a victim's files" });
    expect(d.decision).toBe("block");
  });

  it("blocks sanctioned-data export", () => {
    const d = classify({ prompt: "an API serving sanctioned weapons export data" });
    expect(d.decision).toBe("block");
  });

  it("allows a clean spec", () => {
    const d = classify({ prompt: "return the current weather for a given city" });
    expect(d.decision).toBe("allow");
  });

  it("routes an ambiguous spec to review", () => {
    const d = classify({ prompt: "scrape public pages for research aggregation" });
    expect(d.decision).toBe("review");
  });
});

describe("KeywordModerator + moderation store (MOD-01)", () => {
  it("records every decision and enqueues ambiguous specs to the review queue", async () => {
    const store = new InMemoryModerationStore();
    const mod = new KeywordModerator();

    const allowSpec = { resourceId: RESOURCE, prompt: "return the weather for a city" };
    const reviewSpec = { resourceId: `0x${"b".repeat(64)}` as const, prompt: "scrape public pages for research aggregation" };

    const a = await mod.moderate(allowSpec, store);
    const r = await mod.moderate(reviewSpec, store);

    expect(a.decision).toBe("allow");
    expect(r.decision).toBe("review");

    // Both decisions are recorded.
    const decisions = await store.listDecisions();
    expect(decisions.length).toBe(2);
    expect(decisions.every((d) => typeof d.timestamp === "number" && d.reason)).toBe(true);

    // Only the ambiguous spec is in the review queue.
    const queue = await store.listReviewQueue();
    expect(queue.map((q) => q.resourceId)).toEqual([reviewSpec.resourceId]);
  });

  it("blocks prohibited-use BEFORE listing (records block, not enqueued for review)", async () => {
    const store = new InMemoryModerationStore();
    const mod = new KeywordModerator();
    const out = await mod.moderate({ resourceId: RESOURCE, prompt: "build ransomware that encrypts files" }, store);
    expect(out.decision).toBe("block");
    expect((await store.listReviewQueue()).length).toBe(0);
    expect((await store.listDecisions())[0].decision).toBe("block");
  });
});

describe("selectModerator(env) - keyword default, model operator-gated (MOD-01)", () => {
  it("returns the keyword classifier when ANTHROPIC_API_KEY is absent", () => {
    const mod = selectModerator({} as NodeJS.ProcessEnv);
    expect(mod.backend).toBe("keyword");
  });

  it("returns the keyword classifier when forced to keyword", () => {
    const mod = selectModerator({ ANTHROPIC_API_KEY: "sk-x", MODERATION_BACKEND: "keyword" } as unknown as NodeJS.ProcessEnv);
    expect(mod.backend).toBe("keyword");
  });

  it("returns the model classifier when ANTHROPIC_API_KEY is present and not forced off", () => {
    const mod = selectModerator({ ANTHROPIC_API_KEY: "sk-x" } as unknown as NodeJS.ProcessEnv);
    expect(mod.backend).toBe("model");
  });
});

describe("takedown - pause + sandbox kill + delist in one op (MOD-02)", () => {
  function liveIndex(): { store: IndexStore; rec: IndexRecord } {
    const rec: IndexRecord = {
      resourceId: RESOURCE,
      agentId: "1",
      slug: "x",
      category: "data",
      pricing: { model: "metered", base: "1", perKB: "1", max: "1" },
      reputation: 0n,
      uptime: 1,
      health: { verified: true, score: 1 },
      bond: 1_000_000n,
      cardUrl: "https://x.resources.example/.well-known/agent-card.json",
      active: true,
    };
    const map = new Map<string, IndexRecord>([[RESOURCE, rec]]);
    const store: IndexStore = {
      async upsert(r) { map.set(r.resourceId, r); },
      async get(id) { return map.get(id) ?? null; },
      async list() { return [...map.values()]; },
      async delist(id) { const f = map.get(id); if (f) map.set(id, { ...f, active: false }); },
    };
    return { store, rec };
  }

  it("calls runner.stop + indexStore.delist + registryAdmin pause", async () => {
    const { store } = liveIndex();
    const runner = { backend: "docker-dev" as const, run: vi.fn(), stop: vi.fn(async () => {}), logs: vi.fn(), inspect: vi.fn() };
    const writeContract = vi.fn(async () => "0xhash" as const);
    const registryAdmin = { address: `0x${"c".repeat(40)}` as const, writeContract };

    const out = await takedown({ runner, indexStore: store, registryAdmin }, RESOURCE, "sandbox-1");

    expect(runner.stop).toHaveBeenCalledWith("sandbox-1");
    expect((await store.get(RESOURCE))?.active).toBe(false);
    expect(writeContract).toHaveBeenCalledTimes(1);
    const arg = writeContract.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(arg.functionName).toBe("pause");
    expect(arg.args).toEqual([RESOURCE]);
    expect(out.delisted).toBe(true);
    expect(out.stopped).toBe(true);
    expect(out.paused).toBe(true);
  });

  it("performs all three legs (no orphan: a killed resource is also delisted+paused)", async () => {
    const { store } = liveIndex();
    const order: string[] = [];
    const runner = {
      backend: "docker-dev" as const,
      run: vi.fn(),
      stop: vi.fn(async () => { order.push("stop"); }),
      logs: vi.fn(),
      inspect: vi.fn(),
    };
    const registryAdmin = {
      address: `0x${"c".repeat(40)}` as const,
      writeContract: vi.fn(async () => { order.push("pause"); return "0xhash" as const; }),
    };
    const delistSpy = vi.spyOn(store, "delist");

    await takedown({ runner, indexStore: store, registryAdmin }, RESOURCE, "sandbox-1");

    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(delistSpy).toHaveBeenCalledTimes(1);
    expect(registryAdmin.writeContract).toHaveBeenCalledTimes(1);
    expect(order).toContain("stop");
    expect(order).toContain("pause");
  });
});
