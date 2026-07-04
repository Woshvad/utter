// wallet.tsx - the STU-06 wallet / escrow surface (D-STU-06).
//
// The loader reads a runtime decimals through the adapter (getEscrowBalance) so the
// SSR shell can render a 6dp-aware placeholder without a chain call (no 6/1e6
// literal), plus the ArcScan explorer base for the transaction TxLinks. The client
// wallet UI (escrow balance from useEscrowBalance, the AddArcTestnet control, the
// deposit/withdraw forms, and the on-chain transaction feed) is rendered behind a
// mounted guard to avoid the SSR hydration flash (Pitfall 6 / T-06-HYDRATION) - the
// server renders the neutral disconnected state; the client fills in the connected
// account + balance + real transaction history.
//
// The transaction history is the connected account's REAL on-chain escrow events -
// PaymentEscrow.Deposited (money in) + Withdrawn (money out), read via
// useWalletTransactions - never fabricated sample rows. When no wallet is connected
// (or the account has no escrow history) it renders an honest empty state.
//
// Wallet leads yellow (money) with red on the destructive withdraw confirm only.
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useAccount } from "wagmi";
import { arcTestnet } from "@utter/chain";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import { useEscrowBalance } from "../wallet/useEscrowBalance.js";
import { useAccruedEarnings } from "../wallet/useAccruedEarnings.js";
import { useWalletTransactions, type WalletTx } from "../wallet/useWalletTransactions.js";
import { AddArcTestnet } from "../wallet/AddArcTestnet.js";
import { UsdcAmount } from "../components/primitives/UsdcAmount.js";
import { TxLink } from "../components/primitives/TxLink.js";
import { EscrowBalanceWidget } from "../components/wallet/EscrowBalanceWidget.js";
import { DepositForm } from "../components/wallet/DepositForm.js";
import { WithdrawForm } from "../components/wallet/WithdrawForm.js";

/** The serialized loader payload: the runtime decimals + the ArcScan explorer base. */
export interface WalletData {
  decimals: number;
  explorer: string;
}

/**
 * Resolve the ArcScan explorer base: the ARC_EXPLORER env (the repo-wide ArcScan
 * source) if set, else the @utter/chain arcTestnet block-explorer URL. Mirrors the
 * dashboard's resolveExplorer - we never hardcode a second explorer constant.
 */
function resolveExplorer(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.ARC_EXPLORER?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return arcTestnet.blockExplorers?.default.url ?? "";
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
  return { decimals, explorer: resolveExplorer(process.env) };
}

/** A small mounted guard: false on the server + first client render, true after mount. */
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * A real transaction row from the on-chain escrow feed. A deposit (money IN) leads
 * yellow with a `+`; a withdrawal (money OUT) is muted with a `−`. The amount renders
 * through the single UsdcAmount surface (runtime decimals, no literal); the hash links
 * to ArcScan via TxLink; the block number is the real ordering metadata.
 */
function TxFeedRow({
  tx,
  decimals,
  explorer,
}: {
  tx: WalletTx;
  decimals: number;
  explorer: string;
}): React.ReactElement {
  const isIn = tx.dir === "in";
  const color = isIn ? "var(--yellow)" : "var(--ink-muted)";
  return (
    <div
      data-testid="wallet-tx-row"
      data-dir={tx.dir}
      className="flex items-center gap-[14px] border-b border-hairline px-[18px] py-[14px]"
    >
      <span
        aria-hidden="true"
        className="flex-none rounded-full"
        style={{ width: 9, height: 9, background: color }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink lowercase">
          {isIn ? "deposit" : "withdraw"}
        </div>
        <TxLink hash={tx.tx} explorer={explorer} className="text-[11px]" />
      </div>
      <div className="text-right">
        <div className="flex items-center justify-end gap-[4px] font-mono text-[14px] font-bold tabular-nums" style={{ color }}>
          <span aria-hidden="true">{isIn ? "+" : "−"}</span>
          <UsdcAmount baseUnits={tx.amount} decimals={decimals} />
        </div>
        <div className="font-mono text-[11px] text-ink-faint">block #{tx.blockNumber.toString()}</div>
      </div>
    </div>
  );
}

export default function WalletRoute(): React.ReactElement {
  const { decimals, explorer } = useLoaderData<typeof loader>();
  const mounted = useMounted();
  const { address } = useAccount();

  // A monotonic token bumped after a deposit/withdraw confirms so the escrow balance +
  // the transaction feed re-read (the move-money controls below call refresh()). Carries
  // no money value.
  const [refreshToken, setRefreshToken] = React.useState(0);
  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);

  // Read the wallet's USDC token balance through readUsdcBalance (runtime decimals) once
  // mounted + an account is connected. This is the DEPOSIT source. Before mount the hook
  // is a no-op (loading:false).
  const balance = useEscrowBalance({ address: mounted ? address : undefined, refreshToken });

  // Read the ACCRUED escrow balance (PaymentEscrow.balanceOf) - the WITHDRAWABLE source
  // escrow.withdraw pays out, distinct from the wallet USDC above. Same mounted guard +
  // refreshToken so it re-reads after a withdraw confirms.
  const accrued = useAccruedEarnings({ address: mounted ? address : undefined, refreshToken });

  // Read the REAL on-chain transaction feed (Deposited + Withdrawn) for the connected
  // account. Bypasses the adapter (a direct chain read, like the sibling read hooks); in
  // fixture/disconnected mode it stays empty (no fabricated rows).
  const txs = useWalletTransactions({ address: mounted ? address : undefined, refreshToken });

  // Prefer the runtime-read decimals; fall back to the loader's SSR decimals. The accrued
  // read shares the same USDC decimals; prefer whichever runtime read has resolved.
  const renderDecimals = accrued.decimals ?? balance.decimals ?? decimals;
  const txDecimals = txs.decimals ?? renderDecimals;
  const txRecords = txs.records ?? [];

  return (
    <div className="mx-auto max-w-[1100px] px-[32px] pb-[64px] pt-[28px]">
      <h1
        data-testid="wallet-title"
        className="mb-[24px] text-[26px] font-semibold tracking-[-0.02em] text-ink lowercase"
      >
        wallet &amp; escrow
      </h1>

      {/* top grid: escrow balance card (1.3fr) + deposit card (1fr) */}
      <div className="mb-[16px] grid grid-cols-[1.3fr_1fr] gap-[16px]">
        <EscrowBalanceWidget
          address={mounted ? address : undefined}
          baseUnits={balance.raw}
          decimals={balance.raw !== undefined ? (balance.decimals ?? renderDecimals) : undefined}
          loading={balance.loading}
          label="WALLET USDC · BALANCE"
        />

        {/* the deposit/withdraw card: client-only (mounted guard) - it reads the
            connected account + chain via wagmi, so SSR-rendering would hydrate with a
            different value and flash (Pitfall 6 / T-06-HYDRATION). Each tx is signed
            in the user's own wallet; on confirm we refresh the escrow balance. */}
        {mounted ? (
          <section
            data-testid="wallet-deposit-card"
            className="flex flex-col gap-[12px] border border-hairline bg-raised p-[24px]"
          >
            <DepositForm decimals={balance.decimals ?? renderDecimals} onDeposited={refresh} />

            {/* The withdrawable source: the creator's ACCRUED escrow balance
                (PaymentEscrow.balanceOf), what escrow.withdraw pays out. This is the
                visible source the withdraw button below draws from - distinct from the
                wallet USDC card (the deposit source) on the left. Rendered through the
                single UsdcAmount surface (runtime decimals, no literal). */}
            {accrued.raw !== undefined ? (
              <span
                data-testid="wallet-withdrawable"
                className="font-mono text-[11px] tracking-[0.06em] text-ink-faint"
              >
                IN ESCROW (WITHDRAWABLE){" "}
                <UsdcAmount
                  baseUnits={accrued.raw}
                  decimals={accrued.decimals ?? renderDecimals}
                  className="text-yellow"
                />
              </span>
            ) : null}

            <WithdrawForm
              baseUnits={accrued.raw}
              decimals={accrued.decimals ?? renderDecimals}
              onWithdrawn={refresh}
            />
            {/* network control: keep the AddArcTestnet affordance in the deposit card */}
            <AddArcTestnet />
          </section>
        ) : (
          <section
            data-testid="wallet-deposit-card"
            className="flex flex-col gap-[12px] border border-hairline bg-raised p-[24px]"
          >
            <span className="font-mono text-[12px] tracking-[0.06em] text-ink-faint">DEPOSIT</span>
            <span className="font-mono text-[11px] text-ink-faint">
              connect a wallet to deposit
            </span>
          </section>
        )}
      </div>

      {/* bottom: the REAL on-chain transaction history (deposits + withdrawals), full
          width. No sample rows and no buyer-side spend-cap panel (spend caps are a
          buyer/facilitator concept with no creator-side data source on this surface). */}
      <section data-testid="wallet-tx-history" className="border border-hairline bg-raised">
        <div className="flex items-center justify-between border-b border-hairline px-[18px] py-[16px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
          <span>TRANSACTION HISTORY</span>
        </div>
        {!mounted || !address ? (
          <div
            data-testid="wallet-tx-disconnected"
            className="px-[18px] py-[20px] font-mono text-[12px] text-ink-faint lowercase"
          >
            connect a wallet to see transactions
          </div>
        ) : txs.loading ? (
          <div
            data-testid="wallet-tx-loading"
            className="px-[18px] py-[20px] font-mono text-[12px] text-ink-muted lowercase"
          >
            loading transactions…
          </div>
        ) : txs.error ? (
          <div
            data-testid="wallet-tx-error"
            className="px-[18px] py-[20px] font-mono text-[12px] text-ink-muted lowercase"
          >
            transactions unavailable
          </div>
        ) : txRecords.length === 0 ? (
          <div
            data-testid="wallet-tx-empty"
            className="px-[18px] py-[20px] font-mono text-[12px] text-ink-faint lowercase"
          >
            no transactions yet
          </div>
        ) : (
          txRecords.map((t) => (
            <TxFeedRow key={t.tx} tx={t} decimals={txDecimals} explorer={explorer} />
          ))
        )}
      </section>
    </div>
  );
}
