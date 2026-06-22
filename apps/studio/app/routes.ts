// routes.ts - the React Router v7 framework-mode route config (explicit, not the
// file convention). Registers the STU-* creator-flow routes:
//   /                        -> the landing / marketing front door (index)
//   /create                  -> the composer action + screen (STU-01) [requireCreator]
//   /dashboard               -> the revenue dashboard (STU-04)        [requireCreator]
//   /wallet                  -> the wallet/escrow surface (STU-06)    [requireCreator]
//   /keys                    -> the API-key mint/list (STU-05)        [requireCreator]
//   /metrics                 -> the OBS-01 Prometheus exposition      [token/session]
//   /resources/:id           -> the resource-detail loader + screen (STU-03)
//   /resources/:id/events    -> the SSE build-stream resource route (STU-02)
//   /creators/:address       -> the public creator channel profile (loader + screen)
//   /auth                    -> the SIWE handshake (GET nonce / POST verify, STU-05)
//
// WR-01: dashboard/wallet/metrics existed on disk but were unregistered (dead); they
// are now served WITH the CR-01 access gate applied (the gate is in each loader/action,
// and /metrics carries its own WR-03 token/session gate). The events route is a
// resource route (loader only, no default component); it sits at a distinct path
// segment so it does not collide with the detail route.
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("create", "routes/create.tsx"),
  route("discover", "routes/discover.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("wallet", "routes/wallet.tsx"),
  route("keys", "routes/keys.tsx"),
  route("metrics", "routes/metrics.ts"),
  route("resources/:id", "routes/resources.$id.tsx"),
  route("resources/:id/events", "routes/resources.$id.events.ts"),
  route("creators/:address", "routes/creators.$address.tsx"),
  route("auth", "routes/auth.tsx"),
] satisfies RouteConfig;
