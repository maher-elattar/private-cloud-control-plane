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
USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /workspace/apps/control-api/tools/local-oidc.mjs ./local-oidc.mjs
COPY --from=build --chown=node:node /workspace/apps/proxmox-provider/tools/local-proxmox.mjs ./local-proxmox.mjs
COPY --chown=node:node db ./db
COPY --chown=node:node tools/db ./tools/db
USER node

# The Terraform engine and a vendored provider mirror.
#
# WHY a separate stage: the binary and the provider plugin are fetched once, verified here, and
# copied as bytes into the runtime image. The runtime image therefore needs no package manager, no
# archive tools, and — because the runner is given a plugin directory — no path to a provider
# registry at all.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS terraform-engine
# Pinned exactly, with the published checksum for each architecture this image is built for. A
# floating version would change the engine under a state file that a pinned provider was written
# against.
ARG TERRAFORM_VERSION=1.15.9
ARG TERRAFORM_SHA256_AMD64=76edd0b22d2f27d3d2e097cd793209646f719cf60f02ff3af626b07361137da1
ARG TERRAFORM_SHA256_ARM64=0afa6c29f61ca5ea270e950e43e50ecf2418b598507bf580e8ae76e1e6699b19
ARG TARGETARCH
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /engine
# `sha256sum --check --strict` is the gate: an unexpected download fails the build rather than
# producing an image whose engine nobody chose.
RUN case "${TARGETARCH}" in \
      amd64) checksum="${TERRAFORM_SHA256_AMD64}" ;; \
      arm64) checksum="${TERRAFORM_SHA256_ARM64}" ;; \
      *) echo "No pinned Terraform checksum for ${TARGETARCH}." >&2; exit 1 ;; \
    esac \
  && curl --fail --silent --show-error --location --output terraform.zip \
       "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip" \
  && echo "${checksum}  terraform.zip" | sha256sum --check --strict - \
  && unzip -q terraform.zip -d /usr/local/bin \
  && rm terraform.zip \
  && terraform version

# Vendor the provider from the module's own committed lock file. `providers mirror` selects the
# locked version and refuses anything whose checksum the lock does not record, so the mirror
# cannot contain a provider the repository did not pin.
COPY deploy/terraform/modules/instance ./module
RUN terraform -chdir=./module providers mirror /plugins \
  && test -f /plugins/registry.terraform.io/bpg/proxmox/index.json

# The provider service with a Terraform engine, for `PROVIDER_ADAPTER=terraform`.
#
# Separate from `runtime` because the engine and the vendored plugin are dead weight for the fake
# and direct adapters, and because this image is the only one that can execute a plan.
FROM runtime-common AS terraform-runtime
USER root
# WHY this image needs a system trust store when no other one does: there are two TLS clients
# here and they trust from different places. Node bundles its own CA list, so the direct Proxmox
# client verified the endpoint perfectly — while the provider plugin is a separate Go binary that
# reads `/etc/ssl/certs`, which this base image does not have at all. The result was a clone that
# failed with `x509: certificate signed by unknown authority` against a certificate that is
# publicly trusted, in an image where the other client had just verified it.
#
# The alternative would have been `PROXMOX_VE_INSECURE=true`, which is why this is worth spelling
# out: the fix for a trust-store gap is a trust store.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# The runner copies the module into a fresh directory per run, so this must be writable by the
# service account and nothing else.
RUN install --directory --owner=node --group=node --mode=0700 /var/lib/terraform
COPY --from=terraform-engine /usr/local/bin/terraform /usr/local/bin/terraform
# Read-only to the service: a module it could edit is a module an exploit could edit, and the
# lifecycle block that forbids destroying an instance lives in it.
COPY --from=terraform-engine /plugins /opt/terraform/plugins
COPY --chown=root:root deploy/terraform/modules /opt/terraform/modules
USER node
ENV TERRAFORM_BINARY=/usr/local/bin/terraform \
    TERRAFORM_MODULE_PATH=/opt/terraform/modules/instance \
    TERRAFORM_PURGE_MODULE_PATH=/opt/terraform/modules/instance-purge \
    TERRAFORM_WORKING_ROOT=/var/lib/terraform \
    TERRAFORM_PLUGIN_DIR=/opt/terraform/plugins \
    TF_IN_AUTOMATION=1

# The default target is the production service image and contains no local signing key or DB tools.
FROM runtime-common AS runtime
