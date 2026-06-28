// /health - a CONSTANT liveness resource route (loader-only, no UI). The studio owns
// no store, so its container healthcheck is liveness-only: this answers "is the SSR
// server up and serving HTTP", touching nothing else. It mirrors the deployer/
// marketplace { ok: true, service } shape.
export function loader() {
  return Response.json({ ok: true, service: "studio" });
}
