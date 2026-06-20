// Vitest setup for @utter/studio component tests. Registers the
// @testing-library/jest-dom matchers (toBeInTheDocument, toHaveClass, etc.) and
// auto-cleans the rendered DOM between tests so the jsdom tree stays isolated.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
