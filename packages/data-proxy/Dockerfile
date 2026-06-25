# The data-proxy service image (PRX-01/PRX-02) - the allowlisted egress proxy.
#
# BUILD CONTEXT IS THE REPO ROOT. The compose service sets `context: ..` and
# `dockerfile: packages/data-proxy/Dockerfile`, so every COPY path below is
# relative to the monorepo root, not to packages/data-proxy.
#
# The image runs the service under native Node 22 via the same ts-resolver +
# --experimental-strip-types invocation as the `start` script, so the running
# bytes match what local dev runs. Single-stage on purpose: correct over clever
# for first light. The resource-image digest pinning is a separate increment.
#
# NOTE: this is NOT the untrusted-code isolation boundary. Plain Docker is not a
# security boundary (CLAUDE.md, SPEC §9.5); the data-proxy is the trusted egress
# gateway that runs OUTSIDE the gVisor sandbox.
FROM node:22-bookworm-slim

# pnpm via corepack (the repo's package manager; no global npm install needed).
RUN corepack enable

WORKDIR /app

# Copy the whole repo (the root .dockerignore keeps host node_modules, .git,
# .planning, and .env.local out, so the context stays lean and no secrets are
# baked). pnpm then resolves the workspace from the manifests + lockfile and
# links the packages the data-proxy imports (@utter/chain et al.).
COPY . .

# Install with the committed lockfile so the image is reproducible.
RUN pnpm install --frozen-lockfile

EXPOSE 8080

# Run the service the same way the start script does: native Node + the
# ts-resolver --import hook + --experimental-strip-types, pointed at the
# data-proxy server entrypoint. The path is repo-root relative (the WORKDIR).
CMD ["node", "--import", "./scripts/ts-resolver.mjs", "--experimental-strip-types", "packages/data-proxy/src/server.ts"]
