# Quality Gates

![Continuous-integration quality gates](../diagrams/rendered/ci-quality-gates.mermaid.svg)

## Merge Policy

| Gate | Command or mechanism | Failure condition |
| --- | --- | --- |
| Locked installation | `pnpm install --frozen-lockfile` | Manifest and lockfile differ or lifecycle policy is not reproducible |
| Generated-contract drift | Generate types and tables, then `git diff --exit-code` | Generated TypeScript or contract documentation is stale |
| Contract validation | `pnpm run contracts:validate` | Invalid OpenAPI, protobuf, AsyncAPI, JSON Schema, requirements, size, security, or idempotency invariant |
| Documentation | `pnpm run docs:validate` | Broken local link, missing generated notice, or missing rendered architecture evidence |
| Formatting | `pnpm run format:check` | Prettier would change a tracked source artifact |
| Static analysis | `pnpm run lint` | ESLint rule or Nx dependency boundary violation |
| Types | `pnpm run typecheck` | Any project fails strict TypeScript compilation |
| Unit and conformance tests | `pnpm run test` | Unit, contract, or provider semantic behavior fails |
| Build | `pnpm run build` | Any library or service cannot produce its artifact |
| Dependency audit | `pnpm audit --prod --audit-level high` | A known high or critical production dependency vulnerability is present |
| Container construction | Four-service Docker matrix | A pinned non-root runtime image cannot be built |
| Container vulnerability scan | Trivy image scan | A high or critical fixable vulnerability is present |

## Supply-Chain Boundaries

- GitHub Actions are pinned to immutable commit SHAs with the release version recorded in comments.
- The workflow receives only `contents: read`; it does not deploy, publish, or hold runtime credentials.
- Node.js, pnpm, application dependencies, and image base tags are pinned.
- Container builds install only the service's pruned production dependency graph in the runtime stage.
- Application CI produces evidence only. Image publication and GitOps promotion will be separate reviewed workflows.

## Local Reproduction

The root README lists commands in CI order. Image construction uses:

```bash
docker build \
  --build-arg APP=control-api \
  --tag private-cloud/control-api:local \
  --file tools/docker/service.Dockerfile \
  .
```

Repeat for `provisioning-orchestrator`, `proxmox-provider`, and `reconciler`. Vulnerability database availability is external to the repository, so the dependency and container scan timestamps belong in CI evidence.
