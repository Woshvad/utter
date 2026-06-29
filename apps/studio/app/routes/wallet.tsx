// wallet.tsx - the STU-06 wallet / escrow surface (D-STU-06).
//
// The loader reads a runtime decimals through the adapter (getEscrowBalance) so the
// SSR shell can render a 6dp-aware placeholder without a chain call (no 6/1e6
// literal). The client wallet UI (escrow balance from useEscrowBalance, the
// AddArcTestnet control, the deposit/withdraw forms) is rendered behind a mounted
// guard to avoid the SSR hydration flash (Pitfall 6 / T-06-HYDRATION) - the server
// renders the neutral disconnected state; the client fills in the connected account
// + balance.
//
// Layout pixel-matches Design/Utter.dc.html comp lines 582-636: a 1100px content
// column with an h1 "wallet & escrow", a top 1.3fr/1fr grid (escrow card + deposit
// card) and a bottom 1.3fr/1fr grid (transaction history + agent spend caps). The
// transaction-history and agent-spend-cap rows have NO real data source on this
// surface, so they render the comp's deterministic representative sample data
// (comp data 1041-1052) - clearly fixture, distinct from the real on-chain balance.
//
// Wallet leads yellow (money) with red on the destructive withdraw confirm only.
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useAccount } from "wagmi";
import { selectAdapter } from "../adapter/select.js";
import { requireCreator } from "../auth/requireCreator.server.js";
import { useEscrowBalance } from "../wallet/useEscrowBalance.js";
import { useAccruedEarnings } from "../wallet/useAccruedEarnings.js";
import { AddArcTestnet } from "../wallet/AddArcTestnet.js";
import { UsdcAmount } from "../components/primitives/UsdcAmount.js";
import { EscrowBalanceWidget } from "../components/wallet/EscrowBalanceWidget.js";
import { DepositForm } from "../components/wallet/DepositForm.js";
import { WithdrawForm } from "../components/wallet/WithdrawForm.js";
import { SampleBadge } from "../components/primitives/SampleBadge.js";

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

// ---------------------------------------------------------------------------
// Representative sample data (comp 1041-1052). These are NOT real on-chain
// values - the wallet has no transaction feed or per-agent cap feed wired on
// this surface yet. They render the comp's deterministic fixture so the screen
// pixel-matches; they are intentionally distinct from the live escrow balance.
// ---------------------------------------------------------------------------

interface SampleTx {
  /** "in" => money inflow (yellow); "out" => outflow (ink-muted). */
  dir: "in" | "out";
  label: string;
  /** Pre-formatted human amount string (no scale math on this surface). */
  amt: string;
  hash: string;
  time: string;
}

const SAMPLE_TXS: readonly SampleTx[] = [
  { dir: "in", label: "deposit · usdc", amt: "+$50.00", hash: "0x7a3f…b21c", time: "2h ago" },
  { dir: "out", label: "call · summarize-url", amt: "−$0.0080", hash: "0x91c2…44de", time: "5h ago" },
  { dir: "in", label: "earnings · sentiment-score", amt: "+$12.84", hash: "0x55ab…0f12", time: "9h ago" },
  { dir: "out", label: "call · fx-rates-live", amt: "−$0.0010", hash: "0x33de…aa90", time: "1d ago" },
  { dir: "out", label: "withdraw · to wallet", amt: "−$200.00", hash: "0x12fa…77bd", time: "2d ago" },
];

interface SampleCap {
  name: string;
  used: string;
  cap: string;
  pct: number;
}

const SAMPLE_CAPS: readonly SampleCap[] = [
  { name: "research-agent", used: "$1.24", cap: "$5.00 / day", pct: 25 },
  { name: "ops-bot", used: "$8.90", cap: "$20.00 / day", pct: 45 },
  { name: "scraper-3", used: "$1.98", cap: "$2.00 / day", pct: 99 },
];

/** A representative transaction row (fixture). Money-in rows lead yellow; money-out muted. */
function TxRow({ tx }: { tx: SampleTx }): React.ReactElement {
  const color = tx.dir === "in" ? "var(--yellow)" : "var(--ink-muted)";
  return (
    <div
      data-testid="wallet-tx-row"
      className="flex items-center gap-[14px] border-b border-hairline px-[18px] py-[14px]"
    >
      <span
        aria-hidden="true"
        className="flex-none rounded-full"
        style={{ width: 9, height: 9, background: color }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{tx.label}</div>
        <div className="font-mono text-[11px] text-blue">{tx.hash} ↗</div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[14px] font-bold tabular-nums" style={{ color }}>
          {tx.amt}
        </div>
        <div className="font-mono text-[11px] text-ink-faint">{tx.time}</div>
      </div>
    </div>
  );
}

/** A representative agent spend-cap row (fixture). Progress bar leads blue. */
function CapRow({ cap }: { cap: SampleCap }): React.ReactElement {
  return (
    <div data-testid="wallet-cap-row" className="border-b border-hairline px-[18px] py-[16px]">
      <div className="mb-[8px] flex items-center justify-between">
        <span className="font-mono text-[13px] text-ink">{cap.name}</span>
        <span className="font-mono text-[12px] text-ink-muted">
          {cap.used} / {cap.cap}
        </span>
      </div>
      <div className="h-[6px] border border-hairline bg-canvas">
        <div className="h-full bg-blue" style={{ width: `${cap.pct}%` }} />
      </div>
    </div>
  );
}

export default function WalletRoute(): React.ReactElement {
  const { decimals } = useLoaderData<typeof loader>();
  const mounted = useMounted();
  const { address } = useAccount();

  // A monotonic token bumped after a deposit/withdraw confirms so the escrow balance
  // re-reads (the move-money controls below call refresh()). Carries no money value.
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

  // Prefer the runtime-read decimals; fall back to the loader's SSR decimals. The accrued
  // read shares the same USDC decimals; prefer whichever runtime read has resolved.
  const renderDecimals = accrued.decimals ?? balance.decimals ?? decimals;

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

      {/* bottom grid: transaction history (1.3fr) + agent spend caps (1fr) */}
      <div className="grid grid-cols-[1.3fr_1fr] gap-[16px]">
        <section
          data-testid="wallet-tx-history"
          className="border border-hairline bg-raised"
        >
          <div className="flex items-center justify-between border-b border-hairline px-[18px] py-[16px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
            <span>TRANSACTION HISTORY</span>
            <SampleBadge />
          </div>
          {SAMPLE_TXS.map((tx) => (
            <TxRow key={tx.hash} tx={tx} />
          ))}
        </section>

        <section
          data-testid="wallet-agent-caps"
          className="border border-hairline bg-raised"
        >
          <div className="flex items-center justify-between border-b border-hairline px-[18px] py-[16px] font-mono text-[12px] tracking-[0.06em] text-ink-faint">
            <span>AGENT SPEND CAPS</span>
            <SampleBadge />
          </div>
          {SAMPLE_CAPS.map((cap) => (
            <CapRow key={cap.name} cap={cap} />
          ))}
        </section>
      </div>
    </div>
  );
}
