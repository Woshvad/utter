# The marketplace service image - the trusted agent-facing discovery + card API.
#
# BUILD CONTEXT IS THE REPO ROOT. The compose service sets `context: ..` and
# `dockerfile: apps/marketplace/Dockerfile`, so every COPY path below is relative
# to the monorepo root, not to apps/marketplace.
#
# The image runs the service under native Node 22 via the same ts-resolver +
# --experimental-strip-types invocation as the `start` script, so the running
# bytes match what local dev runs. No build step: the marketplace executes TS
# directly via the native strip-types resolver. Single-stage on purpose: correct
# over clever for first light.
#
# NOTE: this is NOT the untrusted-code isolation boundary. Plain Docker is not a
# security boundary (CLAUDE.md, SPEC §9.5); the marketplace is a TRUSTED platform
# control-plane service (the A2A card + /resources discovery API) that runs
# OUTSIDE the gVisor sandbox. Its publish endpoint is Bearer-gated (fail-closed);
# GET /resources and the card route are intentionally public for agent discovery.
FROM node:22-bookworm-slim

# pnpm via corepack (the repo's package manager; no global npm install needed).
RUN corepack enable

WORKDIR /app

# Copy the whole repo (the root .dockerignore keeps host node_modules, .git,
# .planning, and .env.local out, so the context stays lean and no secrets are
# baked). pnpm then resolves the workspace from the manifests + lockfile and
# links the packages the marketplace imports (@utter/chain et al.).
COPY . .

# Install with the committed lockfile so the image is reproducible.
RUN pnpm install --frozen-lockfile

EXPOSE 8789

# Container HEALTHCHECK over GET /ready (store-aware readiness). node:22-bookworm-slim
# ships NEITHER curl NOR wget, so the probe uses `node -e` + the global fetch: exit 0
# when /ready is 200 (stores reachable), exit 1 otherwise. The start-period covers the
# pnpm-resolve + boot window. (The compose-level healthcheck block is what
# `condition: service_healthy` reads; this image HEALTHCHECK is the standalone-run one.)
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8789)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run the service the same way the start script does: native Node + the
# ts-resolver --import hook + --experimental-strip-types, pointed at the
# marketplace server entrypoint. PORT defaults to 8789 (also set in the compose
# env). The pnpm -C form runs the package start script from the repo-root WORKDIR.
CMD ["pnpm", "-C", "apps/marketplace", "start"]
