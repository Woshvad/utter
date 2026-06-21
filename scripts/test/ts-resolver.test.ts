import { describe, it, expect } from "vitest";

import { resolve } from "../ts-resolver-hooks.mjs";

// Offline, deterministic unit test for the native-Node ESM resolve() hook.
// No filesystem, no network, no timers: nextResolve is a pure stub that decides
// resolution from the specifier string alone.

// makeStub returns a stub nextResolve plus a calls log. The stub "resolves" only
// when the specifier looks importable under native Node: it ends in .ts or .mjs,
// starts with node:, or looks like a package specifier (starts with @ or is
// exactly "viem"). For those it returns { url: "stub:" + specifier }, recording
// the final specifier it was handed. Anything else throws a resolution-style
// error, matching how Node would reject an extensionless relative specifier.
function makeStub() {
  const calls: string[] = [];
  const stub = async (specifier: string) => {
    calls.push(specifier);
    const importable =
      specifier.endsWith(".ts") ||
      specifier.endsWith(".mjs") ||
      specifier.startsWith("node:") ||
      specifier.startsWith("@") ||
      specifier === "viem";
    if (importable) {
      return { url: "stub:" + specifier };
    }
    const err = new Error("Cannot find module '" + specifier + "'");
    (err as Error & { code?: string }).code = "ERR_MODULE_NOT_FOUND";
    throw err;
  };
  return { calls, stub };
}

describe("ts-resolver resolve()", () => {
  it("appends .ts to an extensionless relative specifier", async () => {
    const { calls, stub } = makeStub();

    const result = await resolve("./arc", {}, stub);

    // The .ts append worked and was the resolved attempt.
    expect(result.url).toBe("stub:./arc.ts");
    // The first attempt the hook makes is the .ts sibling.
    expect(calls[0]).toBe("./arc.ts");
  });

  it("passes a bare package specifier through unchanged exactly once", async () => {
    const { calls, stub } = makeStub();

    const result = await resolve("@utter/chain", {}, stub);

    expect(result.url).toBe("stub:@utter/chain");
    expect(calls).toEqual(["@utter/chain"]);
  });

  it("passes a node builtin specifier through unchanged exactly once", async () => {
    const { calls, stub } = makeStub();

    const result = await resolve("node:fs", {}, stub);

    expect(result.url).toBe("stub:node:fs");
    expect(calls).toEqual(["node:fs"]);
  });

  it("passes an already-extensioned relative specifier through unchanged exactly once", async () => {
    const { calls, stub } = makeStub();

    const result = await resolve("./foo.ts", {}, stub);

    expect(result.url).toBe("stub:./foo.ts");
    expect(calls).toEqual(["./foo.ts"]);
  });
});
