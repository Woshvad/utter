// Vitest setup for @utter/studio component tests. Registers the
// @testing-library/jest-dom matchers (toBeInTheDocument, toHaveClass, etc.) and
// auto-cleans the rendered DOM between tests so the jsdom tree stays isolated.
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from "node:util";

// esbuild asserts at import time (main.js:201) that
// `new TextEncoder().encode("") instanceof Uint8Array`. Under jsdom this is false,
// which crashes every test file that transitively imports a route loader. The cause
// is a realm split between two global constructors: jsdom's TextEncoder produces a
// Uint8Array from its own realm, and the test-global Uint8Array is from a third
// realm, so the instanceof check fails. We align both ends to Node's
// implementations: install Node's TextEncoder and TextDecoder, then point
// globalThis.Uint8Array at the exact constructor Node's encoder emits (read off a
// real encode() result rather than assumed) so the invariant holds. This runs at
// setup-module evaluation, before any test module (and thus esbuild) is imported.
// configurable and writable mirror the localStorage polyfill below so the swap
// holds even if jsdom defined these as non-writable.
const nodeUint8Array = new NodeTextEncoder().encode("").constructor;
Object.defineProperty(globalThis, "Uint8Array", {
  configurable: true,
  writable: true,
  value: nodeUint8Array,
});
Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  writable: true,
  value: NodeTextEncoder,
});
Object.defineProperty(globalThis, "TextDecoder", {
  configurable: true,
  writable: true,
  value: NodeTextDecoder,
});

// Hermetic file-backed API-key store: point STUDIO_API_KEYS_PATH at a UNIQUE path
// under the OS temp dir so the FileApiKeyStore never writes into the repo (no .data
// artifact) and never bleeds keys across runs. The path is unique per worker process
// (pid + random suffix) so parallel test files do not collide. We remove the file
// before and after the run to keep each suite starting clean.
const STUDIO_KEYS_TEST_PATH = join(
  tmpdir(),
  `utter-studio-api-keys.${process.pid}.${Math.random().toString(36).slice(2)}.json`,
);
process.env.STUDIO_API_KEYS_PATH = STUDIO_KEYS_TEST_PATH;

function removeKeyStoreFile(): void {
  try {
    rmSync(STUDIO_KEYS_TEST_PATH, { force: true });
  } catch {
    // best effort - the file may not exist
  }
}

beforeAll(removeKeyStoreFile);
afterAll(removeKeyStoreFile);

// jsdom under Node does not always expose a working localStorage, so provide a small
// in-memory polyfill for component tests that persist UI state (e.g. the follow toggle).
// It is only installed when one is not already present.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage,
  });
}

afterEach(() => {
  cleanup();
  if (typeof globalThis.localStorage !== "undefined") globalThis.localStorage.clear();
});
