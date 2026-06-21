// routes.ts - the React Router v7 framework-mode route config (explicit, not the
// file convention). Registers the STU-01/02/03 creator-flow routes built in Plan 04:
//   /create                  -> the composer action + screen (STU-01)
//   /resources/:id           -> the resource-detail loader + screen (STU-03)
//   /resources/:id/events    -> the SSE build-stream resource route (STU-02)
//
// The events route is a resource route (loader only, no default component); it sits
// at a distinct path segment so it does not collide with the detail route.
import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("create", "routes/create.tsx"),
  route("resources/:id", "routes/resources.$id.tsx"),
  route("resources/:id/events", "routes/resources.$id.events.ts"),
] satisfies RouteConfig;
