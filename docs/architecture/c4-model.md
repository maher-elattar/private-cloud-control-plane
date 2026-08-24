# C4 Architecture Model

## Level 1: System Context

```mermaid
flowchart LR
    Tenant["Person: Tenant Developer"]
    Admin["Person: Platform Administrator"]
    SRE["Person: Site Reliability Engineer"]

    ControlPlane["Software System: Private Cloud Control Plane<br/>Accepts provider-neutral VM commands, executes durable workflows, reconciles state, and exposes operational evidence"]

    Identity["External System: Identity Provider<br/>Authenticates users and supplies claims"]
    Foundation["External System: Kubernetes Foundation<br/>Gateway API, TLS, RKE2, Cilium, Longhorn, and Argo CD"]
    Proxmox["External System: Proxmox VE<br/>Creates and manages lab QEMU VMs"]
    Delivery["External System: Live GitOps Repository<br/>Owns runtime desired state and promotion"]
    AWS["External System: AWS Sandbox<br/>Hosts the bounded serverless command path"]

    Tenant -->|"REST or gRPC commands and queries"| ControlPlane
    Admin -->|"Catalog, recovery, retention, and purge"| ControlPlane
    SRE -->|"Diagnosis, replay, and reconciliation review"| ControlPlane
    ControlPlane -->|"Validates identity and claims"| Identity
    Foundation -->|"Routes and runs workloads"| ControlPlane
    ControlPlane -->|"Provider-neutral operations through adapter"| Proxmox
    Delivery -->|"Declares application and platform versions"| Foundation
    ControlPlane -->|"Uses alternate command-store contracts"| AWS
```

### Context Responsibilities

| Relationship | Contract |
| --- | --- |
| People to control plane | Provider-neutral resources and operation IDs; no provider credentials or identifiers |
| Control plane to identity provider | Authentication and claims only; identity lifecycle is external |
| Control plane to Proxmox | Provider adapter is the only mutating path |
| Live repository to foundation | Reviewed declarative desired state and immutable image digests |
| Control plane to AWS sandbox | Same domain identity and event concepts, bounded to command acceptance and publication |

## Level 2: Container View

```mermaid
flowchart TB
    subgraph Clients["Clients"]
        CLI["CLI or API Client"]
        Operator["Operator Workflow"]
    end

    Gateway["Existing Gateway API and TLS"]

    subgraph K8s["Kubernetes Control Plane Runtime"]
        API["Container: Control API<br/>NestJS REST and gRPC<br/>Catalog, desired state, operations, outbox, read projections"]
        Orchestrator["Container: Provisioning Orchestrator<br/>NestJS Kafka consumer<br/>Inbox, checkpoints, retries, compensation"]
        Provider["Container: Proxmox Provider<br/>NestJS gRPC adapter<br/>Provider translation and task polling"]
        Reconciler["Container: Reconciler<br/>Scheduled observed-state comparison<br/>Drift and late-outcome classification"]

        PostgreSQL[("PostgreSQL<br/>Domain state, operations, outbox, inbox, checkpoints, leases, projections")]
        Debezium["Kafka Connect and Debezium<br/>Outbox change-data capture"]
        Kafka[("Kafka<br/>Commands, events, audit, dead letter")]
        KEDA["KEDA<br/>Kafka lag scaling"]
        OTel["OpenTelemetry Collector"]
    end

    subgraph Providers["Provider Boundary"]
        PVE["Proxmox VE API"]
    end

    subgraph Observability["Observability Backends"]
        Prometheus[("Prometheus")]
        Tempo[("Tempo")]
        Loki[("Loki")]
        Grafana["Grafana"]
    end

    subgraph AwsSlice["Bounded AWS Reference Slice"]
        APIGW["API Gateway HTTP API"]
        CommandLambda["Command Lambda"]
        DynamoDB[("DynamoDB<br/>Aggregate and outbox items")]
        RelayLambda["Streams Relay Lambda"]
        SQS[("SQS FIFO and DLQ")]
        Watchdog["EventBridge Scheduler and Watchdog Lambda"]
        Archive[("S3 Audit Archive")]
        CloudWatch["CloudWatch"]
    end

    CLI --> Gateway
    Operator --> Gateway
    Gateway --> API
    API --> PostgreSQL
    PostgreSQL --> Debezium
    Debezium --> Kafka
    Kafka --> Orchestrator
    Orchestrator --> PostgreSQL
    Orchestrator --> Provider
    Provider --> PVE
    Reconciler --> Provider
    Reconciler --> PostgreSQL
    Reconciler --> Kafka
    Kafka --> API
    KEDA --> Orchestrator

    API --> OTel
    Orchestrator --> OTel
    Provider --> OTel
    Reconciler --> OTel
    OTel --> Prometheus
    OTel --> Tempo
    OTel --> Loki
    Prometheus --> Grafana
    Tempo --> Grafana
    Loki --> Grafana

    CLI --> APIGW
    APIGW --> CommandLambda
    CommandLambda --> DynamoDB
    DynamoDB --> RelayLambda
    RelayLambda --> SQS
    Watchdog --> DynamoDB
    RelayLambda --> Archive
    CommandLambda --> CloudWatch
    RelayLambda --> CloudWatch
    Watchdog --> CloudWatch
```

### Container Rules

1. The four application deployables are Control API, Provisioning Orchestrator, Proxmox Provider, and Reconciler. Datastores, brokers, operators, and telemetry components are platform dependencies rather than additional application services.
2. The Control API is the only public application container.
3. The Proxmox Provider is the only container permitted to know Proxmox request and response types or hold a Proxmox credential reference.
4. The accepting API writes PostgreSQL and never depends synchronously on Kafka or Proxmox.
5. Debezium publishes committed outbox records. It does not own domain decisions.
6. The orchestrator owns execution state, not public resource definitions.
7. The reconciler observes and classifies. It does not perform destructive correction.
8. KEDA can change consumer replica count, while an independent concurrency control protects the provider.
9. Telemetry export failure must not sit on a command or provider critical path.
10. The AWS slice is a contract and reliability comparison, not a second provider execution plane.

## Deployment Ownership

| Element | Source ownership |
| --- | --- |
| Four application containers and shared packages | `private-cloud-control-plane` |
| Container images | Built from `private-cloud-control-plane` and addressed by digest |
| Kubernetes resources, platform dependencies, dashboards, and alerts | `private-cloud-platform-live` |
| RKE2, Cilium, Gateway, TLS, Longhorn, and Argo bootstrap | `private-cloud-foundation` |
| AWS Terraform and its verification artifacts | `private-cloud-platform-live` |
