// wallet.tsx - the STU-06 wallet / escrow surface (D-STU-06).
//
// The loader reads a runtime decimals through the adapter (getEscrowBalance) so the
// SSR shell can render a 6dp-aware placeholder without a chain call (no 6/1e6
// literal). The client wallet UI (escrow balance from useEscrowBalance, the
// AddArcTestnet control, the WalletPill) is rendered behind a mounted guard to avoid
// the SSR hydration flash (Pitfall 6 / T-06-HYDRATION) - the server renders the
// neutral disconnected state; the client fills in the connected account + balance.
//
// Wallet leads yellow (money) with red on the destructive withdraw confirm.
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useAccount } from "wagmi";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import { useEscrowBalance } from "../wallet/useEscrowBalance.js";
import { AddArcTestnet } from "../wallet/AddArcTestnet.js";
import { EscrowBalanceWidget } from "../components/wallet/EscrowBalanceWidget.js";
import { DepositForm } from "../components/wallet/DepositForm.js";
import { WithdrawForm } from "../components/wallet/WithdrawForm.js";
import { WalletPill } from "../components/shell/WalletPill.js";

/** The serialized loader payload: the runtime decimals for the SSR placeholder. */
export interface WalletData {
  decimals: number;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<WalletData> {
  // Access gate (CR-01): the wallet/escrow + payout surface is creator-only.
  // requireCreator throws redirect(/auth) or 401 before any balance read.
  await requireCreator(request);

  const adapter = selectAdapter(process.env);
  // Runtime money scale read through the adapter (no 6/1e6 literal). The live path
  // reads decimals() on-chain; the fixture returns deterministic decimals.
  const { decimals } = await adapter.getEscrowBalance(
    "0x0000000000000000000000000000000000000000",
  );
  return { decimals };
}

/** A small mounted guard: false on the server + first client render, true after mount. */
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

export default function WalletRoute(): React.ReactElement {
  const { decimals } = useLoaderData<typeof loader>();
  const mounted = useMounted();
  const { address } = useAccount();

  // A monotonic token bumped after a deposit/withdraw confirms so the escrow balance
  // re-reads (the move-money controls below call refresh()). Carries no money value.
  const [refreshToken, setRefreshToken] = React.useState(0);
  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);

  // Read the escrow balance through readUsdcBalance (runtime decimals) once mounted +
  // an account is connected. Before mount the hook is a no-op (loading:false).
  const balance = useEscrowBalance({ address: mounted ? address : undefined, refreshToken });

  // Prefer the runtime-read decimals; fall back to the loader's SSR decimals.
  const renderDecimals = balance.decimals ?? decimals;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-xl p-xl">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <h1 data-testid="wallet-title" className="text-display font-display lowercase text-ink">
          wallet
        </h1>
        {/* the shell pill: client-only (mounted guard) to avoid the hydration flash */}
        {mounted ? (
          <WalletPill
            account={address}
            escrowBaseUnits={balance.raw}
            escrowDecimals={balance.raw !== undefined ? renderDecimals : undefined}
          />
        ) : (
          <WalletPill />
        )}
      </div>

      <EscrowBalanceWidget
        baseUnits={balance.raw}
        decimals={balance.raw !== undefined ? renderDecimals : undefined}
        loading={balance.loading}
      />

      {/* move-money controls: client-only (mounted guard) - they read the connected
          account + chain via wagmi, so rendering them on the server would hydrate
          with a different value and flash (Pitfall 6 / T-06-HYDRATION). Each tx is
          signed in the user's own wallet; on confirm we refresh the escrow balance. */}
      {mounted ? (
        <div className="flex flex-col gap-lg">
          <DepositForm decimals={balance.decimals ?? renderDecimals} onDeposited={refresh} />
          <WithdrawForm
            baseUnits={balance.raw}
            decimals={balance.decimals ?? renderDecimals}
            onWithdrawn={refresh}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-xs">
        <span className="text-label font-display lowercase text-ink-muted">network</span>
        <AddArcTestnet />
      </div>
    </div>
  );
}
