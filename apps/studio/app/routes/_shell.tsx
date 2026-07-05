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
  // The SIWE-authenticated address, or null when nobody is signed in. The shell NEVER
  // gates - public in-shell routes (playground, profile) render it too - but signed-out
  // it presents a NEUTRAL state (a "sign in" avatar, no escrow, no owned resources)
  // rather than a fixture identity.
  const authAddress = await getAuthAddress(request);

  // Escrow figure for the sidebar footer + topbar pill. Read ONLY for a REAL signed-in
  // address: an anonymous visitor must never see a balance. Falling back to the fixture
  // address here would read THAT address's public on-chain escrow and render it as if it
  // were the visitor's own balance (misleading). No session -> no figure (the shell shows
  // "-" and the topbar pill is hidden). Best-effort: a live-backend read can throw, in
  // which case the shell also shows "-".
  let escrow: { raw: string; decimals: number } | null = null;
  if (authAddress) {
    try {
      const bal = await adapter.getEscrowBalance(authAddress as Hex);
      escrow = { raw: bal.raw.toString(), decimals: bal.decimals };
    } catch {
      escrow = null;
    }
  }

  // "Your resources": ONLY the signed-in creator's OWN resources, scoped by each card's
  // owner projection (creator). A signed-out visitor sees none - the marketplace top-list
  // is not "yours". One list read (no N+1 detail reads); a card without a creator
  // projection never matches, so nothing another creator owns can appear here.
  let resources: ResourceEntry[] = [];
  if (authAddress) {
    const owner = authAddress.toLowerCase();
    try {
      const cards = await adapter.listMarketplace({} as FilterCriteria);
      resources = cards
        .filter((c) => typeof c.creator === "string" && c.creator.toLowerCase() === owner)
        .slice(0, 6)
        .map((c) => ({
          label: c.slug,
          href: `/resources/${c.resourceId}`,
          status: c.active ? ("live" as const) : ("paused" as const),
        }));
    } catch {
      resources = [];
    }
  }

  // account is the SIWE address, or null when signed out (drives the neutral shell state).
  return { account: authAddress, escrow, resources };
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
        account: account ?? undefined,
        onUtter: () => navigate("/create"),
        onSearch: (q) => {
          // Free-text discover search: the loader reads the `q` param (see discover.tsx).
          // Only navigate on a non-empty query so an empty submit is a no-op.
          const trimmed = q.trim();
          if (trimmed) {
            navigate(`/discover?${new URLSearchParams({ q: trimmed }).toString()}`);
          }
        },
      }}
    >
      <Outlet />
    </AppShell>
  );
}
