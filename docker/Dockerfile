# syntax=docker/dockerfile:1

# Multi-stage image for the `dsh` CLI/Web UI, built from repository source
# (not the published @deepseek-ai/dsh npm package) so the image always
# reflects local, possibly unreleased, changes.
#
# `pnpm deploy` was evaluated and rejected for the runtime stage: its output
# does not preserve the pnpm-workspace.yaml `overrides` that redirect the
# vendored @deepseek-ai/cosmokit and @deepseek-ai/schemastery to vendor/, so
# a deployed tree fails at startup with ERR_MODULE_NOT_FOUND. The runtime
# stage below instead copies the complete workspace (packages/, vendor/,
# native/, apps/) and its full node_modules virtual store from the builder.

ARG NODE_VERSION=24-slim

########################################
# 1. deps: install the full pnpm workspace (cached while lockfile is unchanged)
########################################
FROM node:${NODE_VERSION} AS deps

# CI=true short-circuits the postinstall hooks installer (scripts/install-lefthook.mjs),
# which otherwise requires a .git directory that this build context does not carry.
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app
# pnpm needs every workspace member's package.json to resolve the monorepo
# graph, and the `patches/` directory pnpm-workspace.yaml's patchedDependencies
# refers to, so the install step copies the whole tree rather than a
# package.json-only subset.
COPY . .
RUN pnpm install --frozen-lockfile

########################################
# 2. build: compile lib/ output and the web frontend
########################################
FROM deps AS build

# repositoryCommitHash() (scripts/client-build-environment.ts) requires either
# a resolvable `git rev-parse HEAD` or this env var; the build context has no
# .git, so it must be supplied explicitly.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
ENV CI=true

RUN pnpm run build

########################################
# 3. runtime: the smallest image that can still resolve the full workspace graph
########################################
FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

# Full workspace tree, including vendor/ (linked overrides) and native/
# (Landlock launcher), plus the complete node_modules virtual store built
# above. node:${NODE_VERSION} already ships an unprivileged `node` user
# (uid/gid 1000); reuse it instead of provisioning a new one.
COPY --from=build --chown=node:node /app /app

ENV NODE_ENV=production \
    DSH_HOME=/home/node/.dsh

RUN mkdir -p ${DSH_HOME} && chown -R node:node ${DSH_HOME} \
  && chmod +x /app/apps/cli/lib/bin.js \
  && ln -s /app/apps/cli/lib/bin.js /usr/local/bin/dsh

USER node

# dsh web serves the browser UI on 127.0.0.1:3080 by default. The CLI
# intentionally refuses --host 0.0.0.0 for safety, so this port is only
# reachable from outside the container via --network=host or a reverse
# proxy that terminates on the host and forwards to 127.0.0.1 in-container.
EXPOSE 3080

CMD ["dsh", "web", "--no-open"]
