import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { LinksFunction } from "react-router";
import * as React from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import tokens from "./styles/tokens.css?url";
import tailwind from "./styles/tailwind.css?url";
import { wagmiConfig } from "./wallet/config";

// The dark-Bauhaus token layer (Plan 02) + the wagmi + QueryClient providers (Plan
// 05, this plan). `tokens.css` carries the CSS variables every Tailwind utility
// resolves against. wagmiConfig has ssr:true so the providers are SSR-safe (Pitfall
// 6 / T-06-HYDRATION); wallet-dependent UI still guards on a mounted flag.
//
// tokens.css is linked first so its :root custom properties are declared, then the
// compiled Tailwind sheet (preflight + utilities). Custom properties resolve at use
// site, so the vars apply regardless of order; tokens-first keeps intent clear.
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: tokens },
  { rel: "stylesheet", href: tailwind },
];

// A single QueryClient for the app (wagmi's required async-state peer). Created once
// per module load (module scope) so it is stable across renders.
const queryClient = new QueryClient();

// Minimal SSR shell. Keep it minimal but valid so the route tree has a root.
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * The app providers: WagmiProvider (the single wagmiConfig on arcTestnet, ssr:true)
 * wrapping QueryClientProvider (wagmi's required peer) wrapping the route Outlet. Kept
 * minimal + additive so later plans (auth, etc.) can layer their own providers inside.
 */
export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
