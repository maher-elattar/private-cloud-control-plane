# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc nx.json tsconfig*.json ./
COPY tools/docker/tsconfig.phase4.json ./tsconfig.json
# Copy only the Phase 4 deployment graph so additional workspace applications cannot alter the
# production image inputs.
COPY apps/control-api ./apps/control-api
COPY apps/provisioning-orchestrator ./apps/provisioning-orchestrator
COPY apps/proxmox-provider ./apps/proxmox-provider
COPY apps/reconciler ./apps/reconciler
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile
COPY eslint.config.mjs ./
ARG APP
RUN pnpm nx run "${APP}:build" && pnpm nx run "${APP}:prune"

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime-common
ARG APP
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node "/workspace/apps/${APP}/dist" ./
COPY tools/docker/pnpm-workspace.runtime.yaml ./pnpm-workspace.yaml
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  corepack enable \
  && corepack prepare pnpm@11.3.0 --activate \
  && pnpm config set store-dir /pnpm/store \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

USER node
EXPOSE 3000
CMD ["node", "main.js"]

FROM runtime-common AS local-runtime
COPY --from=build --chown=node:node /workspace/apps/control-api/tools/local-oidc.mjs ./local-oidc.mjs
COPY --chown=node:node db ./db
COPY --chown=node:node tools/db ./tools/db

# The default target is the production service image and contains no local signing key or DB tools.
FROM runtime-common AS runtime
