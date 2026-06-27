// auth-route.test.tsx - the STU-05 AuthRoute navigate-on-success behavior (FIX 2).
//
// After a successful SIWE verify the /auth action returns { ok: true, address }. The
// AuthRoute must navigate to /dashboard so the modal does not sit on "signed - verifying…"
// forever. This is a cosmetic client navigation only; the action JSON contract, verifySiwe,
// session handling, and SiweModal wiring are unchanged.
//
// react-router is mocked so useFetcher / useNavigate / useLoaderData are inert (no real
// Router needed); wagmi is mocked the same way auth-siwe-modal.test.tsx does so the nested
// SiweModal renders without a browser wallet. The fetcher state/data is read from a mutable
// module-scope value so each case can drive a different fetcher result.
import { describe, it, expect, vi, beforeEach } from "vitest";

const navigateMock = vi.fn();
let fetcherForTest: { data: unknown; state: string } = { data: undefined, state: "idle" };

vi.mock("react-router", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useFetcher: () => ({
      data: fetcherForTest.data,
      state: fetcherForTest.state,
      submit: vi.fn(),
      Form: () => null,
    }),
    useNavigate: () => navigateMock,
    useLoaderData: () => ({ nonce: "0123456789abcdef" }),
  };
});

// Mirror auth-siwe-modal.test.tsx: mock wagmi so the nested SiweModal renders inert.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useConnect: () => ({ connect: vi.fn(), connectors: [] }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));

beforeEach(() => {
  navigateMock.mockReset();
  fetcherForTest = { data: undefined, state: "idle" };
});

async function renderRoute() {
  const { render, waitFor } = await import("@testing-library/react");
  const React = await import("react");
  const mod = await import("../app/routes/auth");
  render(React.createElement(mod.default));
  return { waitFor };
}

describe("AuthRoute navigate-on-success (FIX 2)", () => {
  it("navigates to /dashboard once when the verify fetcher is idle and ok === true", async () => {
    fetcherForTest = { data: { ok: true, address: "0xabc" }, state: "idle" };
    const { waitFor } = await renderRoute();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/dashboard"));
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT navigate when the fetcher has no data yet", async () => {
    fetcherForTest = { data: undefined, state: "idle" };
    await renderRoute();
    // Give any (incorrect) effect a tick to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 0));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("does NOT navigate when the verify reports ok === false", async () => {
    fetcherForTest = { data: { ok: false }, state: "idle" };
    await renderRoute();
    await new Promise((r) => setTimeout(r, 0));
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
