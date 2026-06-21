// Placement tests for @utter/orchestrator (SCL-01 Task 2).
//
// Asserts `place` is a PURE least-loaded bin-packing function: lowest current
// load under the per-host concurrency cap, ties broken by the lowest host index,
// no-capacity when every host is at cap. Deterministic - no wall-clock, no
// random (CONTEXT SCL-01). Pure-input/pure-output: the same inputs always yield
// the same placement.
import { describe, it, expect } from "vitest";
import { place, type Host } from "../src/index";

const HOSTS: Host[] = [{ id: "h0" }, { id: "h1" }, { id: "h2" }];

describe("place (pure least-loaded bin-packing)", () => {
  it("picks the least-loaded host under the cap", () => {
    const result = place(HOSTS, { h0: 3, h1: 1, h2: 4 }, 5);
    expect(result).toEqual({ placed: true, hostId: "h1", index: 1 });
  });

  it("breaks ties by the lowest host index (deterministic)", () => {
    // h0 and h1 are equally loaded; the lowest index (h0) wins.
    const result = place(HOSTS, { h0: 2, h1: 2, h2: 3 }, 5);
    expect(result).toEqual({ placed: true, hostId: "h0", index: 0 });
  });

  it("treats an absent load entry as 0 (an empty host is least-loaded)", () => {
    const result = place(HOSTS, { h0: 1 }, 5); // h1, h2 implicitly 0
    expect(result).toEqual({ placed: true, hostId: "h1", index: 1 });
  });

  it("signals no-capacity when every host is at the cap", () => {
    const result = place(HOSTS, { h0: 5, h1: 5, h2: 5 }, 5);
    expect(result).toEqual({ placed: false, reason: "no-capacity" });
  });

  it("skips hosts at the cap and places on an eligible one", () => {
    const result = place(HOSTS, { h0: 5, h1: 5, h2: 2 }, 5);
    expect(result).toEqual({ placed: true, hostId: "h2", index: 2 });
  });

  it("is deterministic: identical inputs yield identical output", () => {
    const load = { h0: 4, h1: 1, h2: 1 };
    const a = place(HOSTS, load, 5);
    const b = place(HOSTS, load, 5);
    expect(a).toEqual(b);
    // tie between h1 and h2 -> lowest index h1
    expect(a).toEqual({ placed: true, hostId: "h1", index: 1 });
  });
});
