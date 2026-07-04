// limits-build-slots.test.ts - the in-flight build cap (S4).
//
// Constructs BuildSlots directly (never the module singleton) so the cap is
// explicit and no env is touched.
import { describe, it, expect } from "vitest";
import { BuildSlots, TooManyBuildsError } from "../app/limits/build-slots.server";

/** Await a real timer for ms milliseconds (the deadline uses setTimeout). */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("BuildSlots", () => {
  it("hands out slots up to the cap, then throws TooManyBuildsError", () => {
    const slots = new BuildSlots(2);
    slots.acquire();
    slots.acquire();
    expect(slots.active).toBe(2);
    expect(() => slots.acquire()).toThrow(TooManyBuildsError);
    // The error message is the one the create action surfaces on the browser path.
    expect(() => slots.acquire()).toThrow(/build capacity/);
  });

  it("release frees exactly one slot", () => {
    const slots = new BuildSlots(1);
    const release = slots.acquire();
    expect(() => slots.acquire()).toThrow(TooManyBuildsError);
    release();
    expect(slots.active).toBe(0);
    expect(() => slots.acquire()).not.toThrow();
  });

  it("release is idempotent: a double release cannot free a second slot", () => {
    const slots = new BuildSlots(2);
    const releaseA = slots.acquire();
    slots.acquire();
    expect(slots.active).toBe(2);
    releaseA();
    releaseA(); // second call is a no-op
    expect(slots.active).toBe(1);
    slots.acquire();
    expect(() => slots.acquire()).toThrow(TooManyBuildsError);
  });

  it("carries the typed code the create action switches on", () => {
    const slots = new BuildSlots(0);
    try {
      slots.acquire();
      expect.unreachable("acquire must throw at cap 0");
    } catch (err) {
      expect(err).toBeInstanceOf(TooManyBuildsError);
      expect((err as TooManyBuildsError).code).toBe("too_many_builds");
    }
  });

  it("auto-releases a slot after its deadline so a wedged build cannot brick the pool (S4b)", async () => {
    // A build that never calls release (wedged claude-code subprocess / stalled deploy
    // stream) must not hold its slot forever. Acquire with a tiny deadline and never
    // release; after the deadline the slot frees and admission recovers.
    const slots = new BuildSlots(1, 20);
    slots.acquire(); // deliberately drop the release fn: this build "wedges"
    expect(slots.active).toBe(1);
    expect(() => slots.acquire()).toThrow(TooManyBuildsError);
    await wait(40);
    expect(slots.active).toBe(0);
    expect(() => slots.acquire()).not.toThrow();
  });

  it("a build that finishes after its deadline elapsed does not double-free (idempotent)", async () => {
    const slots = new BuildSlots(2, 20);
    const release = slots.acquire(); // auto-releases at 20ms
    slots.acquire(20);
    expect(slots.active).toBe(2);
    await wait(40); // both auto-release
    expect(slots.active).toBe(0);
    release(); // the wedged build's real release lands late - must be a no-op
    expect(slots.active).toBe(0);
  });

  it("ttl 0 disables the deadline (a slot is held until explicitly released)", async () => {
    const slots = new BuildSlots(1, 20);
    slots.acquire(0); // no deadline
    await wait(40);
    expect(slots.active).toBe(1);
    expect(() => slots.acquire()).toThrow(TooManyBuildsError);
  });
});
