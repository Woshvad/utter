import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { LinksFunction } from "react-router";
import tokens from "./styles/tokens.css?url";

// The dark-Bauhaus token layer is now wired in (Plan 02). The wagmi + QueryClient
// providers are still deferred to Plan 05 (wallet). `tokens.css` carries the CSS
// variables every Tailwind utility resolves against.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: tokens }];

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

export default function App() {
  return <Outlet />;
}
