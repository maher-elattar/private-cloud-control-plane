# Repository Boundaries

## Lifecycle Separation

Three repositories own three different change lifecycles.

| Repository | Responsibility | Examples | Explicit Exclusions |
| --- | --- | --- | --- |
| `private-cloud-foundation` | Existing cluster foundation | Proxmox host design, RKE2, Cilium, Gateway API, Traefik, cert-manager, Longhorn, Argo CD bootstrap | Application images, Kafka topics, application dashboards, AWS command path |
| `private-cloud-control-plane` | Application and contract lifecycle | NestJS applications, shared domain, REST/gRPC/event contracts, migrations, tests, product docs | Cluster add-ons, environment overlays, live secrets, Argo applications |
| `private-cloud-platform-live` | Runtime desired state | Operators, Kafka, PostgreSQL, KEDA, observability, application manifests, dashboards, alerts, AWS Terraform | Business logic and provider adapter source |

The current repository is `private-cloud-control-plane`.

## Application Repository Shape

```text
apps/
  control-api/
  provisioning-orchestrator/
  proxmox-provider/
  reconciler/
  aws-command-handler/
  aws-outbox-relay/
packages/
  domain/
  contracts/
  provider-sdk/
  observability/
  postgres-adapter/
  dynamodb-adapter/
  testing/
db/
  migrations/
tests/
  contract/
  integration/
  e2e/
  load/
  failure/
docs/
  product/
  architecture/
  adr/
  slo/
  runbooks/
  security/
```

This remains one TypeScript monorepo. Deployable boundaries are enforced through package dependencies, contracts, and tests rather than a repository per service.

## GitOps Repository Shape

```text
clusters/
  lab/
platform/
  strimzi/
  kafka/
  kafka-connect/
  cloudnative-pg/
  keda/
  opentelemetry/
  tempo/
  loki/
  prometheus/
  grafana/
applications/
  control-plane/
    base/
    overlays/lab/
observability/
  dashboards/
  alerts/
policies/
  network/
  rbac/
terraform/
  aws/serverless-control-plane/
docs/
  runbooks/
  verification/
```

## Promotion Contract

1. Application CI validates contracts, tests, documentation, dependencies, and container images.
2. Images are published by immutable digest.
3. CI proposes digest changes to `private-cloud-platform-live`.
4. The GitOps change is reviewed independently from application source.
5. Argo CD reconciles only the approved live repository.
6. Runtime verification evidence is recorded with the GitOps change.

The application repository never deploys directly to the cluster. The live repository never builds application source.

## Secret Boundary

- Application source declares configuration names and validation rules.
- The GitOps repository declares secret references and workload wiring.
- Secret values live in the selected secret store and never in Git.
- Provider and AWS credentials are environment-specific and have no source-controlled fallback.
