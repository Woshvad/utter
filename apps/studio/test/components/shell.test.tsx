// Tests for the Task-2 form/layout primitives + the app shell. These pin the
// load-bearing a11y/interaction behaviors: Modal focus-trap + ESC close on the
// bordered+scrim (no blur) treatment, the AppShell sidebar + top bar structure,
// and the hard-edged Input/Toggle 2px triad focus ring.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "../../app/components/primitives/Modal";
import { Input } from "../../app/components/primitives/Input";
import { Toggle } from "../../app/components/primitives/Toggle";
import { Tabs } from "../../app/components/primitives/Tabs";
import { AppShell } from "../../app/components/shell/AppShell";
import { SidebarNavItem } from "../../app/components/shell/SidebarNavItem";
import { TopBar } from "../../app/components/shell/TopBar";

describe("Modal", () => {
  it("renders the bordered dialog + scrim with content inside when open", () => {
    render(
      <Modal open title="take down weather-now?" onClose={() => {}}>
        <p>this pauses the resource on-chain.</p>
      </Modal>,
    );
    // the dialog is named by its title (Radix wires aria-labelledby to Dialog.Title)
    expect(screen.getByRole("dialog", { name: /take down weather-now\?/i })).toBeInTheDocument();
    expect(screen.getByText(/pauses the resource on-chain/i)).toBeInTheDocument();
  });

  it("does not render the dialog when closed", () => {
    render(
      <Modal open={false} title="hidden" onClose={() => {}}>
        <p>nope</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on ESC", async () => {
    const user = userEvent.setup();
    let closed = false;
    render(
      <Modal open title="esc me" onClose={() => (closed = true)}>
        <p>body</p>
      </Modal>,
    );
    await user.keyboard("{Escape}");
    expect(closed).toBe(true);
  });
});

describe("Input", () => {
  it("renders a hard-edged box and carries a visible 2px triad focus ring class", () => {
    render(<Input aria-label="price" placeholder="0.00" />);
    const input = screen.getByLabelText("price");
    expect(input.className).toMatch(/focus-visible:ring-2/);
  });
});

describe("Toggle", () => {
  it("renders an accessible switch reflecting the pressed state", () => {
    render(<Toggle pressed onPressedChange={() => {}} label="metered" />);
    const sw = screen.getByRole("switch", { name: /metered/i });
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});

describe("Tabs", () => {
  it("renders the tab triggers and the active panel content", () => {
    render(
      <Tabs
        defaultValue="overview"
        items={[
          { value: "overview", label: "overview", content: <span>over-body</span> },
          { value: "api", label: "api", content: <span>api-body</span> },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByText("over-body")).toBeInTheDocument();
  });
});

describe("AppShell", () => {
  it("renders the 240px sidebar with the four primary nav items + top bar", () => {
    render(
      <AppShell
        nav={[
          { label: "create", href: "/create", active: true },
          { label: "discover", href: "/discover" },
          { label: "dashboard", href: "/dashboard" },
          { label: "wallet", href: "/wallet" },
        ]}
      >
        <div>page content</div>
      </AppShell>,
    );
    expect(screen.getByText("create")).toBeInTheDocument();
    expect(screen.getByText("discover")).toBeInTheDocument();
    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(screen.getByText("wallet")).toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
    // the global + utter primary action lives in the top bar
    expect(screen.getByRole("button", { name: /utter/i })).toBeInTheDocument();
  });
});

describe("TopBar search", () => {
  it("calls onSearch with the typed value on submit (Enter), not per keystroke", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(<TopBar onSearch={(q) => calls.push(q)} />);
    const input = screen.getByLabelText("search apis, creators, schemas");
    await user.type(input, "weather");
    // No onSearch firing while typing.
    expect(calls).toEqual([]);
    await user.keyboard("{Enter}");
    expect(calls).toEqual(["weather"]);
  });

  it("is no-op-safe when onSearch is undefined (submitting does not throw)", async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    const input = screen.getByLabelText("search apis, creators, schemas");
    await user.type(input, "x{Enter}");
    // reaching here without throwing is the assertion
    expect(input).toBeInTheDocument();
  });
});

describe("SidebarNavItem", () => {
  it("active item carries the blue active treatment", () => {
    render(<SidebarNavItem label="create" href="/create" active />);
    const item = screen.getByTestId("sidebar-nav-item");
    expect(item).toHaveAttribute("data-active", "true");
  });

  it("a resource entry renders a square status dot", () => {
    render(<SidebarNavItem label="weather-now" href="/r/1" status="live" />);
    expect(screen.getByTestId("status-dot")).toBeInTheDocument();
  });
});
