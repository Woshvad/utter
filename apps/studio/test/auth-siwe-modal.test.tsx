// auth-siwe-modal.test.tsx - the STU-05 SiweModal wallet picker.
//
// Pins the Task-4 fix: the metamask and walletconnect buttons each select THEIR matching
// connector (by case-insensitive id/name), not always connectors[0]. The real connect +
// sign + server-nonce binding flow is unchanged; only WHICH connector is chosen changes.
// A button whose connector is not configured is disabled rather than falling back.
//
// wagmi hooks are mocked so no real wallet/provider is needed; the test only asserts the
// connector chosen by each button. No private key or signature path is exercised here.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Two distinct connectors so we can prove the button picks the matching one, not [0].
const injectedConnector = { id: "injected", name: "Injected" };
const walletConnectConnector = { id: "walletConnect", name: "WalletConnect" };

const connectMock = vi.fn();
let connectorsForTest: Array<{ id: string; name: string }> = [];

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useConnect: () => ({ connect: connectMock, connectors: connectorsForTest }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));

beforeEach(() => {
  connectMock.mockReset();
  connectorsForTest = [injectedConnector, walletConnectConnector];
});

async function renderModal() {
  const { render, screen } = await import("@testing-library/react");
  const userEvent = (await import("@testing-library/user-event")).default;
  const React = await import("react");
  const { SiweModal } = await import("../app/components/auth/SiweModal");
  render(
    React.createElement(SiweModal, { nonce: "0123456789abcdef", onSign: () => {} }),
  );
  return { screen, user: userEvent.setup() };
}

describe("SiweModal wallet picker", () => {
  it("metamask button connects with the injected connector (not always [0])", async () => {
    const { screen, user } = await renderModal();
    await user.click(screen.getByTestId("siwe-metamask"));
    expect(connectMock).toHaveBeenCalledWith({ connector: injectedConnector });
  });

  it("walletconnect button connects with the walletConnect connector", async () => {
    const { screen, user } = await renderModal();
    await user.click(screen.getByTestId("siwe-walletconnect"));
    expect(connectMock).toHaveBeenCalledWith({ connector: walletConnectConnector });
  });

  it("disables a button whose connector is not configured (no silent fallback)", async () => {
    // Only the injected connector is configured (the real Utter wagmi config).
    connectorsForTest = [injectedConnector];
    const { screen } = await renderModal();
    expect(screen.getByTestId("siwe-walletconnect")).toBeDisabled();
    expect(screen.getByTestId("siwe-metamask")).not.toBeDisabled();
  });

  it("the primary connect & sign button prefers the injected connector", async () => {
    const { screen, user } = await renderModal();
    await user.click(screen.getByTestId("siwe-connect-sign"));
    expect(connectMock).toHaveBeenCalledWith({ connector: injectedConnector });
  });
});
