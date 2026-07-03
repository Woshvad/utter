// build-channel-evict.test.ts - the S7 build-channel leak fix + eviction rules.
//
// MUST cover (per the hardening spec): a disconnect frees the map entry; an
// unknown-id spray does not grow the map beyond the cap; late-subscriber buffered
// replay still works. All timing goes through the injected clock (no sleeps).
import { describe, it, expect } from "vitest";
import {
  BuildEventChannel,
  BuildChannelAtCapacityError,
} from "../app/adapter/build-channel";
import type { BuildEvent } from "../app/adapter/types";

const E1: BuildEvent = { stage: "Generate", status: "running", log: "one" };
const E2: BuildEvent = { stage: "Generate", status: "ok", log: "two" };

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Drain a generator to completion, collecting every yielded event. */
async function collect(gen: AsyncGenerator<BuildEvent>): Promise<BuildEvent[]> {
  const out: BuildEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("BuildEventChannel (S7)", () => {
  it("late subscriber replay still works: buffered events, then a clean return", async () => {
    const channel = new BuildEventChannel();
    channel.emit("r1", E1);
    channel.emit("r1", E2);
    channel.complete("r1");
    const events = await collect(channel.subscribe("r1"));
    expect(events).toEqual([E1, E2]);
    // The completed entry is retained (for a late reload) until its TTL.
    expect(channel.size).toBe(1);
  });

  it("a parked subscriber returns when complete() lands (existing contract)", async () => {
    const channel = new BuildEventChannel();
    const gen = channel.subscribe("r-unknown");
    const pending = gen.next(); // parks: no events, not done
    channel.complete("r-unknown");
    const { done } = await pending;
    expect(done).toBe(true);
  });

  it("disconnect frees the map entry: an aborted unknown-id subscriber evicts on exit", async () => {
    const channel = new BuildEventChannel();
    const controller = new AbortController();
    const gen = channel.subscribe("sprayed-id", { signal: controller.signal });
    const pending = gen.next(); // parks forever without the abort race
    expect(channel.size).toBe(1);
    controller.abort();
    const { done } = await pending;
    expect(done).toBe(true);
    // Rule (b): never-emitted stream with zero subscribers is evicted immediately.
    expect(channel.size).toBe(0);
  });

  it("an already-aborted signal returns immediately with no events", async () => {
    const channel = new BuildEventChannel();
    channel.emit("r1", E1);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(channel.subscribe("r1", { signal: controller.signal }));
    expect(events).toEqual([]);
  });

  it("an abort mid-stream stops a live subscriber (the wake races the abort)", async () => {
    const channel = new BuildEventChannel();
    const controller = new AbortController();
    const gen = channel.subscribe("r-live", { signal: controller.signal });

    channel.emit("r-live", E1);
    const first = await gen.next();
    expect(first.value).toEqual(E1);

    // Now parked (buffer empty, not done). Abort must wake and terminate it.
    const pending = gen.next();
    controller.abort();
    const { done } = await pending;
    expect(done).toBe(true);
  });

  it("unknown-id spray cannot grow the map beyond the cap; live subscribers refuse", async () => {
    const channel = new BuildEventChannel({ maxStreams: 3 });
    const held: Array<{ gen: AsyncGenerator<BuildEvent>; ctl: AbortController; pending: Promise<unknown> }> = [];
    for (let i = 0; i < 3; i++) {
      const ctl = new AbortController();
      const gen = channel.subscribe(`spray-${i}`, { signal: ctl.signal });
      const pending = gen.next(); // park, holding a live subscriber
      held.push({ gen, ctl, pending });
    }
    expect(channel.size).toBe(3);

    // Every entry has a live subscriber: a 4th stream must REFUSE (throw), and it
    // must throw synchronously from subscribe() so the route can 503 pre-stream.
    expect(() => channel.subscribe("spray-3")).toThrow(BuildChannelAtCapacityError);
    expect(channel.size).toBe(3);

    // Freeing one subscriber makes room again (rule b evicts its entry).
    held[0]!.ctl.abort();
    await held[0]!.pending;
    expect(channel.size).toBe(2);
    expect(() => channel.subscribe("spray-3")).not.toThrow();

    for (const h of held.slice(1)) {
      h.ctl.abort();
      await h.pending;
    }
  });

  it("cap-creating a stream evicts the oldest ZERO-subscriber entry first", async () => {
    const clock = makeClock();
    const channel = new BuildEventChannel({ maxStreams: 2, now: clock.now });
    channel.emit("old", E1);
    clock.advance(10);
    channel.emit("newer", E1);
    expect(channel.size).toBe(2);

    clock.advance(10);
    channel.emit("newest", E1); // at cap: evicts "old" (oldest, zero subscribers)
    expect(channel.size).toBe(2);

    // "newer" survived the eviction and still replays its buffer.
    const gen = channel.subscribe("newer");
    const first = await gen.next();
    expect(first.value).toEqual(E1);
    await gen.return(undefined);

    // "old" lost its buffer (evicted): a fresh aborted subscriber sees nothing.
    const aborted = new AbortController();
    aborted.abort();
    expect(await collect(channel.subscribe("old", { signal: aborted.signal }))).toEqual([]);
  });

  it("rule (a): a complete zero-subscriber stream is evicted after the TTL sweep", async () => {
    const clock = makeClock();
    const channel = new BuildEventChannel({ now: clock.now, completedTtlMs: 1000 });
    channel.emit("done-stream", E1);
    channel.complete("done-stream");
    expect(await collect(channel.subscribe("done-stream"))).toEqual([E1]);
    expect(channel.size).toBe(1);

    // Within the TTL the entry survives (late reload replay window).
    clock.advance(999);
    channel.emit("other", E1);
    expect(channel.size).toBe(2);

    // Past the TTL the lazy sweep (any access) drops it.
    clock.advance(2);
    channel.emit("other", E2);
    expect(channel.size).toBe(1);
  });
});
