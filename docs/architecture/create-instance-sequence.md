# Create Instance Success Sequence

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Tenant as Tenant Developer
    participant Gateway as Gateway API
    participant API as Control API
    participant DB as PostgreSQL
    participant CDC as Debezium
    participant Kafka as Kafka
    participant Orch as Orchestrator
    participant Provider as Proxmox Provider
    participant PVE as Proxmox VE

    Tenant->>Gateway: POST create instance with idempotency key
    Gateway->>API: Authenticated request and trace context
    API->>API: Authorize project and validate catalog and quota
    API->>DB: Begin transaction
    API->>DB: Insert idempotency record, instance, operation, IPv4 lease, and outbox row
    DB-->>API: Commit durable intent
    API-->>Tenant: 202 Accepted with instance ID and operation ID

    CDC->>DB: Read committed outbox change
    CDC->>Kafka: Append CreateInstance command keyed by instance ID
    Kafka->>Orch: Deliver CreateInstance command
    Orch->>DB: Claim inbox receipt and instance workflow lease
    Orch->>DB: Persist pre-provider checkpoint

    Orch->>Provider: Create VM using provider-neutral request
    Provider->>PVE: Submit full clone with allowlisted provider values
    PVE-->>Provider: Provider task reference
    Provider-->>Orch: Accepted provider task reference
    Orch->>DB: Persist task reference before polling

    loop Until provider task stops or deadline is reached
        Orch->>Provider: Read provider task status
        Provider->>PVE: Read task status and bounded log progress
        PVE-->>Provider: Running progress
        Provider-->>Orch: Normalized task state
        Orch->>DB: Update checkpoint and operation progress
    end

    Orch->>Provider: Apply owned VM configuration
    Provider->>PVE: Configure CPU, memory, disk, network, cloud-init, and ownership markers
    PVE-->>Provider: Successful task outcome
    Provider-->>Orch: Normalized success
    Orch->>Provider: Observe VM identity and state
    Provider->>PVE: Read VM config and status
    PVE-->>Provider: Matching owned VM observation
    Provider-->>Orch: Verified observed state

    Orch->>DB: Atomically persist observed state, complete operation, complete inbox, and write event outbox
    CDC->>DB: Read committed event outbox change
    CDC->>Kafka: Append instance and operation events
    Kafka->>API: Deliver events to idempotent projection consumer
    API->>DB: Update project-readable projections
    Tenant->>API: GET operation or instance
    API-->>Tenant: Succeeded operation and active instance
```

## Success Invariants

| Point | Required invariant |
| --- | --- |
| API acknowledgement | Instance, operation, idempotency record, lease, and outbox are committed together |
| Kafka publication | Command event ID is stable and instance ID is the partition key |
| Consumer start | Inbox receipt and instance workflow lease are claimed transactionally |
| Provider submission | Provider profile values are server-side and pass the lab boundary |
| Provider task polling | Task reference exists durably before the first poll |
| Provider completion | Success is not assumed from transport success; live owned state is observed |
| Domain completion | Observed state, operation outcome, inbox completion, and result event outbox commit atomically |
| Projection | Duplicate result events produce the same read model |

## Response Semantics

- The initial response is `202 Accepted`; it means durable intent exists, not that a VM exists.
- The operation remains accepted while Kafka is unavailable.
- Progress is stage-oriented and bounded. Raw provider task logs are not a public API contract.
- A terminal `succeeded` state requires observed ownership and state evidence.
- The tenant never receives provider node, template VMID, storage, bridge credential, session token, or raw provider task identifiers.
