# The studio service image (HOST-STUDIO) - the trusted control-plane UI.
#
# BUILD CONTEXT IS THE REPO ROOT. The compose service sets `context: ..` and
# `dockerfile: apps/studio/Dockerfile`, so every COPY path below is relative to
# the monorepo root, not to apps/studio.
#
# The image builds the react-router app (both the client and the SSR server
# bundle) and serves it with the workspace react-router-serve binary on PORT
# 3000. Single-stage on purpose: correct over clever for first light.
#
# NOTE: this is NOT the untrusted-code isolation boundary. Plain Docker is not a
# security boundary (CLAUDE.md, SPEC §9.5); the studio is a TRUSTED platform
# control-plane service that runs OUTSIDE the gVisor sandbox. The untrusted
# generated handlers run only under runsc on the provisioned host.
FROM node:22-bookworm-slim

# pnpm via corepack (the repo's package manager; no global npm install needed).
RUN corepack enable

WORKDIR /app

# Copy the whole repo (the root .dockerignore keeps host node_modules, .git,
# .planning, build output, and .env.local out, so the context stays lean and no
# secrets are baked). pnpm then resolves the workspace from the manifests +
# lockfile and links the packages the studio imports (@utter/chain et al.).
COPY . .

# Install with the committed lockfile so the image is reproducible.
RUN pnpm install --frozen-lockfile

# Build the studio: react-router build emits build/client (the browser bundle)
# and build/server/index.js (the SSR entry react-router-serve runs).
RUN pnpm -C apps/studio build

EXPOSE 3000

# Serve the built app with the workspace react-router-serve binary, pointed at
# the SSR entry. PORT defaults to 3000 (also set in the compose env).
CMD ["pnpm", "-C", "apps/studio", "exec", "react-router-serve", "./build/server/index.js"]
