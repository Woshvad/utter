import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

// Minimal SSR shell. The wagmi + QueryClient providers and the tokens.css import
// are wired in Plan 05 (wallet) / Plan 02 (tokens); this scaffold keeps the
// document compiling so the route tree has a root. Keep it minimal but valid.
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
