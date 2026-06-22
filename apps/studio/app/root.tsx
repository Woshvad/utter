import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import type { LinksFunction } from "react-router";
import * as React from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import tokens from "./styles/tokens.css?url";
import tailwind from "./styles/tailwind.css?url";
import { wagmiConfig } from "./wallet/config";
import { ErrorState } from "./components/primitives/index.js";

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

/**
 * The root ErrorBoundary. React Router renders the route module's ErrorBoundary INSIDE
 * the exported Layout, so the document shell + linked stylesheets already wrap it - we
 * just return the page content. It branches on isRouteErrorResponse: a thrown 404
 * Response (e.g. resources.$id.tsx's not-found path) gets the branded "not found"
 * screen with a /discover recovery link; any other route error response gets the status
 * label with a go-home link; a non-Response thrown error gets a plain "something broke"
 * screen that NEVER renders the raw error to the user (the design wants a plain message,
 * not a stack dump).
 *
 * It deliberately mounts no WagmiProvider/QueryClientProvider: an error during data load
 * must render even when the providers are unavailable. ErrorState uses a plain anchor for
 * the same reason (no router dependency in the failure path).
 */
export function ErrorBoundary(): React.ReactElement {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return (
        <div className="mx-auto flex max-w-2xl flex-col gap-lg p-xl">
          <ErrorState
            heading="not found"
            message="this resource does not exist or was removed."
            actionHref="/discover"
            actionLabel="browse the marketplace"
          />
        </div>
      );
    }

    // Any other route error response (401/403/500/...): a terse status label + go home.
    const label = `${error.status} ${error.statusText}`.trim().toLowerCase();
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-lg p-xl">
        <ErrorState
          heading={label}
          message="that request could not be completed."
          actionHref="/"
          actionLabel="go home"
        />
      </div>
    );
  }

  // A non-Response thrown error: keep it honest but plain - never leak the raw message.
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-lg p-xl">
      <ErrorState
        heading="something broke"
        message="an unexpected error stopped this page. try again in a moment."
        actionHref="/"
        actionLabel="go home"
      />
    </div>
  );
}
