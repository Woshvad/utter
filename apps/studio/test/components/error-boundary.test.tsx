// error-boundary.test.tsx - the branded error surfaces.
//
// Task 1 covers the ErrorState primitive directly (render the component, assert the
// heading, the plain message, the red-triangle glyph, and the optional recovery
// anchor), following the direct-render pattern in build-step-block.test.tsx.
//
// Task 2 covers the root ErrorBoundary by stubbing react-router's useRouteError +
// isRouteErrorResponse (the vi.doMock react-router idiom from landing.test.tsx) so
// the 404 branch and the generic-error branch are driven deterministically; the
// assertions are on the rendered ErrorState, not on react-router internals.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorState } from "../../app/components/primitives/ErrorState";

describe("ErrorState primitive", () => {
  it("renders the heading, the plain message, and the red-triangle glyph", () => {
    render(<ErrorState heading="something broke" message="the call did not complete." />);
    const block = screen.getByTestId("error-state");
    expect(block).toBeInTheDocument();
    expect(screen.getByText("something broke")).toBeInTheDocument();
    expect(screen.getByText("the call did not complete.")).toBeInTheDocument();
    // the error mark is shape + color (a CSS-border triangle), never color alone.
    expect(screen.getByTestId("error-state-triangle")).toBeInTheDocument();
  });

  it("renders an optional recovery anchor from props", () => {
    render(
      <ErrorState
        heading="not found"
        message="this resource does not exist."
        actionHref="/discover"
        actionLabel="browse the marketplace"
      />,
    );
    const link = screen.getByRole("link", { name: /browse the marketplace/i });
    expect(link).toHaveAttribute("href", "/discover");
  });

  it("renders no recovery anchor when actionHref is omitted", () => {
    render(<ErrorState heading="oops" message="no link here." />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("root ErrorBoundary", () => {
  async function renderBoundary(error: unknown, isRouteError: boolean) {
    vi.resetModules();
    vi.doMock("react-router", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return {
        ...actual,
        useRouteError: () => error,
        isRouteErrorResponse: () => isRouteError,
      };
    });
    const { render, screen } = await import("@testing-library/react");
    const React = await import("react");
    const mod = await import("../../app/root");
    render(React.createElement(mod.ErrorBoundary));
    return { screen };
  }

  it("renders the branded not-found screen with a /discover recovery link for a 404", async () => {
    const { screen } = await renderBoundary(
      { status: 404, statusText: "Not Found", data: {} },
      true,
    );
    expect(screen.getByTestId("error-state")).toBeInTheDocument();
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /browse the marketplace/i });
    expect(link).toHaveAttribute("href", "/discover");
  });

  it("renders the branded something-broke screen for a non-Response error without leaking the raw error", async () => {
    const secret = "ECONNREFUSED at 0xdeadbeef internal-db-host:5432";
    const { screen } = await renderBoundary(new Error(secret), false);
    expect(screen.getByTestId("error-state")).toBeInTheDocument();
    expect(screen.getByText(/something broke/i)).toBeInTheDocument();
    // the raw error text must never reach the user.
    expect(screen.queryByText(new RegExp(secret))).not.toBeInTheDocument();
    // the generic-error recovery goes home.
    const link = screen.getByRole("link", { name: /go home/i });
    expect(link).toHaveAttribute("href", "/");
  });
});
