# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim AS build
ARG APP
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc nx.json tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY eslint.config.mjs ./
RUN pnpm nx run "${APP}:build" && pnpm nx run "${APP}:prune"

FROM node:24.18.0-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node "/workspace/apps/${APP}/dist" ./
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

USER node
EXPOSE 3000
CMD ["node", "main.js"]
