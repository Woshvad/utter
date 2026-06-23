// Vitest setup for @utter/studio component tests. Registers the
// @testing-library/jest-dom matchers (toBeInTheDocument, toHaveClass, etc.) and
// auto-cleans the rendered DOM between tests so the jsdom tree stays isolated.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

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
