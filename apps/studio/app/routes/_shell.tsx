// _shell.tsx - the persistent authed app-shell LAYOUT route (comp lines 166-234).
//
// It mounts the AppShell (248px sidebar + 64px top bar) around every in-shell route
// via <Outlet/>. Landing (/) and auth (/auth) stay full-bleed OUTSIDE this layout, as
// the comp does. The loader reads the escrow balance + a short "your resources" list
// THROUGH the adapter (best-effort, never gates - the access gate stays in each child
// loader); the active nav state is derived from the current pathname. Money crosses the
// loader boundary as a string (no bigint over JSON) and is re-widened to bigint for the
// shell, which formats it via UsdcAmount at a runtime decimals (no 1e6/6 literal).
import * as React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useNavigate } from "react-router";
import type { FilterCriteria } from "@utter/marketplace";
import { selectAdapter } from "../adapter/select.js";
import type { Hex } from "../adapter/types.js";
import { AppShell, type NavEntry, type ResourceEntry } from "../components/shell/AppShell.js";
import { getAuthAddress } from "../auth/session.server.js";
import { FIXTURE_CREATOR } from "../fixtures/index.js";

// The five primary nav rows (comp lines 178-197), in order. "mcp connect" lands in
// increment 9; its /mcp target may 404 until that route file exists - acceptable.
const NAV: ReadonlyArray<{ label: string; href: string }> = [
  { label: "create", href: "/create" },
  { label: "discover", href: "/discover" },
  { label: "dashboard", href: "/dashboard" },
  { label: "wallet", href: "/wallet" },
  { label: "mcp connect", href: "/mcp" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const adapter = selectAdapter(process.env);
  // Display address: the SIWE session address when present, else the fixture creator.
  // This NEVER gates - public in-shell routes (playground, profile) render the shell too.
  const account = (await getAuthAddress(request)) ?? FIXTURE_CREATOR;

  // Escrow figure for the sidebar footer + topbar pill. Best-effort: a live-backend
  // read can throw RequiresLiveServicesError, in which case the shell shows "-".
  let escrow: { raw: string; decimals: number } | null = null;
  try {
    const bal = await adapter.getEscrowBalance(account as Hex);
    escrow = { raw: bal.raw.toString(), decimals: bal.decimals };
  } catch {
    escrow = null;
  }

  // "Your resources" list. Read through listMarketplace (no filter); map to the
  // shell's ResourceEntry shape (no bigint crosses the boundary).
  let resources: ResourceEntry[] = [];
  try {
    const cards = await adapter.listMarketplace({} as FilterCriteria);
    resources = cards.slice(0, 6).map((c) => ({
      label: c.slug,
      href: `/resources/${c.resourceId}`,
      status: c.active ? ("live" as const) : ("paused" as const),
    }));
  } catch {
    resources = [];
  }

  return { account, escrow, resources };
}

export default function ShellLayout(): React.ReactElement {
  const { account, escrow, resources } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const nav: NavEntry[] = NAV.map((n) => ({
    ...n,
    active: pathname === n.href || pathname.startsWith(`${n.href}/`),
  }));

  const escrowBaseUnits = escrow ? BigInt(escrow.raw) : undefined;

  return (
    <AppShell
      nav={nav}
      resources={resources}
      topBar={{
        escrowBaseUnits,
        escrowDecimals: escrow?.decimals,
        account,
        onUtter: () => navigate("/create"),
      }}
    >
      <Outlet />
    </AppShell>
  );
}
